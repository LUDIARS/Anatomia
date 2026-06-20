/**
 * T11 — In-memory code graph builder.
 *
 * Takes a set of FileNodes (each with hashed FunctionNodes, output of G1
 * parse→extract→normalize→hash pipeline) and builds an in-memory directed
 * graph of CodeNodes connected by typed Edges.
 *
 * Two-phase design (required because tree-sitter WASM nodes are invalidated
 * after tree.delete()):
 *
 *   Phase 1 — extractEdgeInfo(files):
 *     Must be called WHILE the underlying tree-sitter trees are still alive
 *     (i.e., before tree.delete()). Walks each function body AST iteratively
 *     and returns plain-data records: callee names, field reads, field writes.
 *
 *   Phase 2 — buildGraph(files, edgeInfo):
 *     Builds the graph from the plain-data records (no AST traversal). Can be
 *     called after tree.delete(). If edgeInfo is omitted and bodyAst is still
 *     live, Phase 1 is run automatically.
 *
 * Edge kinds derived from the function body AST:
 *   calls   — a call_expression whose callee name resolves to another function
 *   reads   — field/member access not on the LHS of an assignment
 *   writes  — field/member access on the LHS of an assignment
 *
 * (depends / overrides / includes are G4/G3 concerns; they are not derived
 * from function bodies and are left to higher layers to add.)
 *
 * Cross-file call resolution heuristic (best-effort, documented):
 *   1. Build a global name → AnchorId[] map from all provided functions.
 *   2. For each call_expression, extract the callee name (terminal simple name:
 *      `obj.method()` → `method`, `Ns::foo()` → `foo`) and the receiver (the
 *      object the method is called on: `target.alive()` → `target`).
 *   3. Resolve the target(s), in order of precedence:
 *      a. TYPE-aware — if the receiver's static type T is known (a class in the
 *         analyzed code), restrict candidates to `method` defined on T or its
 *         bases. If none match (pure-virtual interface case), DROP the edge
 *         rather than fan out to every same-named override (see type-resolve.ts).
 *      b. LOCALITY — otherwise (unqualified call, or receiver type unknown),
 *         prefer same-file then same-directory candidates (see localityResolve).
 *   4. Calls to unknown names (stdlib, external, unresolved) are silently
 *      dropped — no phantom nodes.
 *   5. Cycles (recursion, mutual recursion) are preserved; this is a general
 *      graph, not a DAG.
 *
 * reads/writes heuristic:
 *   - field_expression / member_access_expression on the LHS of an
 *     assignment_expression → writes edge (if field name maps to a known fn).
 *   - Same access NOT on LHS → reads edge.
 *   - Bare identifier accesses are excluded (local/param noise too high).
 *   - If a writes edge is already emitted for a pair, the reads edge is skipped.
 *
 * Limits:
 *   - Type resolution is receiver-based and single-level: it types a receiver
 *     that is a plain parameter / local variable / `this`, not a chained
 *     expression (`a.b.method()`) or a call result. Member fields are not typed.
 *   - Macro expansions / template instantiations are opaque.
 *   - Only function-to-function edges are built; file-level dependencies
 *     (#include / using) are left for G3/G4.
 */

import type { Node as AstNode } from "web-tree-sitter";
import type { AnchorId, CodeNode, Edge, EdgeKind, FileNode, FunctionNode } from "../types.js";
import { findDeclaratorName, simpleTypeName, templateElementName } from "../dag/extract.js";
import { TypeRegistry } from "./type-resolve.js";

// ---------------------------------------------------------------------------
// Edge-info: plain data extracted from AST before tree deletion
// ---------------------------------------------------------------------------

/**
 * A single call site: the callee's terminal name plus the receiver it is called
 * on (the object before `.`/`->`), used for type-aware resolution.
 *   `target.alive()` → { name: "alive", receiver: "target" }
 *   `this->tick()`   → { name: "tick",  receiver: "this" }
 *   `helper()`       → { name: "helper", receiver: null }  (unqualified)
 *   `a.b.run()`      → { name: "run",   receiver: null }  (chained, not typed)
 */
export interface CallSite {
  name: string;
  receiver: string | null;
}

/**
 * Plain-data summary of the edges that originate from one function.
 * Produced by extractEdgeInfo() while the AST is still live.
 */
export interface FunctionEdgeInfo {
  /** AnchorId of the source function. */
  anchorId: AnchorId;
  /** Call sites (name + receiver) extracted from call expressions. */
  calls: CallSite[];
  /** Field/member names read (not assigned). */
  readFieldNames: string[];
  /** Field/member names written (LHS of assignment). */
  writeFieldNames: string[];
  /**
   * Receiver-variable → simple type name, merged from the caller's parameters
   * and local variable declarations. Drives type-aware call resolution.
   */
  symbolTypes: Record<string, string>;
  /** Simple name of the class this function is a method of (types `this`). */
  selfType?: string;
}

// ---------------------------------------------------------------------------
// Internal graph representation
// ---------------------------------------------------------------------------

export interface CodeGraph {
  /** All nodes keyed by AnchorId. */
  nodes: Map<AnchorId, CodeNode>;
  /**
   * Adjacency list: from AnchorId → list of outgoing edges.
   * Cycles are preserved (no acyclicity constraint).
   */
  adjacency: Map<AnchorId, Edge[]>;
  /** Reverse adjacency: to AnchorId → list of incoming edges. */
  reverseAdjacency: Map<AnchorId, Edge[]>;
  /** All edges (deduplicated by from+to+kind). */
  edges: Edge[];
  /**
   * Type registry used to resolve calls by receiver type. Carried on the graph
   * so verify's diff overlay (augmentGraph) can extend it with the diff's types
   * instead of rebuilding it over the whole repo. Always set by buildGraph /
   * augmentGraph; optional only so hand-built test fixtures (which never run edge
   * resolution) can omit it.
   */
  typeRegistry?: TypeRegistry;
}

// ---------------------------------------------------------------------------
// Iterative AST-walking helpers (avoids call-stack overflow on deep trees)
// ---------------------------------------------------------------------------

/** Collect all descendant nodes of given types using an iterative BFS. */
function descendantsIterative(root: AstNode, types: Set<string>): AstNode[] {
  const result: AstNode[] = [];
  const stack: AstNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (types.has(n.type)) result.push(n);
    // Push children in reverse so leftmost is processed first.
    const children = n.children;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child) stack.push(child);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Callee name extraction
// ---------------------------------------------------------------------------

/**
 * Extract the terminal simple name from a call expression's callee.
 *
 * C++  : call_expression → function field (identifier | qualified_identifier |
 *         field_expression | scoped_identifier | …)
 * C#   : invocation_expression → function field (identifier |
 *         member_access_expression)
 *
 * We always take the rightmost leaf name so that `Ns::foo()` and `obj.foo()`
 * both resolve to `foo`.
 */
function terminalName(node: AstNode): string | null {
  const t = node.type;
  if (t === "identifier") return node.text;
  if (t === "field_identifier") return node.text;
  if (t === "type_identifier") return node.text;

  // qualified_identifier / scoped_identifier: use `name` field or last child.
  if (t === "qualified_identifier" || t === "scoped_identifier") {
    const nameField = node.childForFieldName("name");
    if (nameField) return terminalName(nameField);
    const children = node.namedChildren;
    const last = children[children.length - 1];
    if (last) return terminalName(last);
  }

  // C++ field_expression: `obj.field` or `ptr->field`
  if (t === "field_expression") {
    const field = node.childForFieldName("field");
    if (field) return terminalName(field);
  }

  // C# member_access_expression: `obj.Method`
  if (t === "member_access_expression") {
    const name = node.childForFieldName("name");
    if (name) return terminalName(name);
  }

  // Generic fallback: try `name` field.
  const nameField2 = node.childForFieldName("name");
  if (nameField2) return terminalName(nameField2);

  return null;
}

// ---------------------------------------------------------------------------
// Assignment LHS detection
// ---------------------------------------------------------------------------

/** Is this AST node the LHS of an assignment expression? */
function isAssignmentLhs(node: AstNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  const t = parent.type;
  const isAssign =
    t === "assignment_expression" ||
    t === "compound_assignment_expression" ||
    t === "augmented_assignment_expression";
  if (!isAssign) return false;
  const lhs = parent.childForFieldName("left") ?? parent.namedChildren[0];
  return lhs === node;
}

// ---------------------------------------------------------------------------
// Phase 1: extractEdgeInfo — must be called while AST is live
// ---------------------------------------------------------------------------

/**
 * Extract plain-data edge information from a FunctionNode's body AST.
 * MUST be called before tree.delete().
 *
 * @param fn  A FunctionNode with a live bodyAst and an assigned id.
 */
export function extractFunctionEdgeInfo(fn: FunctionNode): FunctionEdgeInfo | null {
  if (!fn.id) return null;

  const body = fn.bodyAst;
  const calls: CallSite[] = [];
  const readFieldNames: string[] = [];
  const writeFieldNames: string[] = [];

  // ── calls (name + receiver) ────────────────────────────────────────────────
  const callTypes = new Set(["call_expression", "invocation_expression"]);
  const callNodes = descendantsIterative(body, callTypes);
  const seenCall = new Set<string>();
  for (const call of callNodes) {
    const site = extractCallSite(call);
    if (!site) continue;
    const key = `${site.name}\0${site.receiver ?? ""}`;
    if (seenCall.has(key)) continue; // deduplicate at source
    seenCall.add(key);
    calls.push(site);
  }

  // ── reads / writes ────────────────────────────────────────────────────────
  // Only field_expression / member_access_expression (not bare identifiers —
  // too much local noise).
  const fieldTypes = new Set(["field_expression", "member_access_expression"]);
  const fieldNodes = descendantsIterative(body, fieldTypes);

  for (const n of fieldNodes) {
    const fieldNode =
      n.childForFieldName("field") ?? n.childForFieldName("name");
    if (!fieldNode) continue;
    const fieldName = fieldNode.type === "identifier" || fieldNode.type === "field_identifier"
      ? fieldNode.text
      : null;
    if (!fieldName) continue;

    if (isAssignmentLhs(n)) {
      writeFieldNames.push(fieldName);
    } else {
      readFieldNames.push(fieldName);
    }
  }

  // ── symbol types (params + locals + range-for loop vars) ────────────────────
  const symbolTypes: Record<string, string> = {};
  // containerElem: var → element type of a container template it holds, used to
  // type `for (auto* x : container)` loop variables.
  const containerElem: Record<string, string> = {};
  for (const p of fn.params ?? []) {
    if (p.type) symbolTypes[p.name] = p.type;
    if (p.elementType) containerElem[p.name] = p.elementType;
  }
  collectLocalTypes(body, symbolTypes, containerElem);
  resolveRangeForTypes(body, symbolTypes, containerElem);

  return {
    anchorId: fn.id,
    calls,
    readFieldNames: [...new Set(readFieldNames)],
    writeFieldNames: [...new Set(writeFieldNames)],
    symbolTypes,
    ...(fn.enclosingType ? { selfType: fn.enclosingType } : {}),
  };
}

/**
 * Extract `{ name, receiver }` from a call/invocation node. `receiver` is the
 * object the method is invoked on when it is a plain identifier or `this`; it is
 * null for an unqualified call or a chained/complex receiver (which we do not
 * type — see Limits).
 */
function extractCallSite(callNode: AstNode): CallSite | null {
  const fnField =
    callNode.childForFieldName("function") ?? callNode.childForFieldName("method");
  if (!fnField) return null;
  const name = terminalName(fnField);
  if (!name) return null;

  let receiver: string | null = null;
  if (fnField.type === "field_expression") {
    // C++ `obj.method` / `ptr->method`
    receiver = simpleReceiver(fnField.childForFieldName("argument"));
  } else if (fnField.type === "member_access_expression") {
    // C# `obj.Method`
    receiver = simpleReceiver(fnField.childForFieldName("expression"));
  }
  return { name, receiver };
}

/** Reduce a receiver expression to a variable name, `this`, or null. */
function simpleReceiver(node: AstNode | null): string | null {
  if (!node) return null;
  if (node.type === "identifier") return node.text;
  if (node.type === "this" || node.type === "this_expression") return "this";
  return null; // chained field_expression, call result, etc. — not typed
}

/** Local declaration node types whose declared variables we type. */
const LOCAL_DECL_TYPES = new Set<string>([
  "declaration", // C++
  "variable_declaration", // C# (also nested under local_declaration_statement)
]);

/**
 * Walk the body collecting local declaration types:
 *   - `out`           : varName → simple class type (for direct receiver typing)
 *   - `containerElem` : varName → element type of a container template it holds
 *                       (for `for (auto* x : var)` loop-variable typing)
 */
function collectLocalTypes(
  body: AstNode,
  out: Record<string, string>,
  containerElem: Record<string, string>,
): void {
  const decls = descendantsIterative(body, LOCAL_DECL_TYPES);
  for (const decl of decls) {
    const typeNode = decl.childForFieldName("type");
    const typeName = simpleTypeName(typeNode);
    const elemName = templateElementName(typeNode);
    if (!typeName && !elemName) continue; // primitive / auto / var → not a class
    if (decl.type === "declaration") {
      // C++: one or more declarators (init_declarator / ref / pointer / id).
      const declarators = decl.childrenForFieldName("declarator");
      for (const d of declarators) {
        const name = d ? findDeclaratorName(d) : null;
        if (!name) continue;
        if (typeName) out[name] = typeName;
        if (elemName) containerElem[name] = elemName;
      }
    } else {
      // C#: variable_declarator children carry the `name` field.
      for (const d of decl.namedChildren) {
        if (!d || d.type !== "variable_declarator") continue;
        const nameNode = d.childForFieldName("name") ?? d.namedChildren[0];
        if (!nameNode || nameNode.type !== "identifier") continue;
        if (typeName) out[nameNode.text] = typeName;
        if (elemName) containerElem[nameNode.text] = elemName;
      }
    }
  }
}

/**
 * Type the loop variables of C++ range-based for loops (`for (T x : container)`):
 *   - explicit element type `T`         → that type;
 *   - `auto`/`auto*`/`auto&` over a var → the container var's element type
 *     (so `for (auto* r : receivers)` types `r` as the vector's element class).
 * Member-field containers (`for (auto& y : items_)`) are not typed — only
 * parameter / local containers we have an element type for.
 */
function resolveRangeForTypes(
  body: AstNode,
  out: Record<string, string>,
  containerElem: Record<string, string>,
): void {
  const loops = descendantsIterative(body, new Set(["for_range_loop"]));
  for (const loop of loops) {
    const declarator = loop.childForFieldName("declarator");
    const loopVar = declarator ? findDeclaratorName(declarator) : null;
    if (!loopVar) continue;
    const typeNode = loop.childForFieldName("type");
    if (typeNode && typeNode.type !== "placeholder_type_specifier") {
      // Explicit element type, e.g. `for (IDamageReceiver* r : …)`.
      const explicit = simpleTypeName(typeNode);
      if (explicit) out[loopVar] = explicit;
      continue;
    }
    // `auto` element: resolve via the container variable's element type.
    const right = loop.childForFieldName("right");
    if (right && right.type === "identifier") {
      const elem = containerElem[right.text];
      if (elem) out[loopVar] = elem;
    }
  }
}

/**
 * Extract edge info for all functions across a list of FileNodes.
 * Call this BEFORE tree.delete() for any of the underlying trees.
 *
 * @returns Map from AnchorId → FunctionEdgeInfo
 */
export function extractEdgeInfo(files: FileNode[]): Map<AnchorId, FunctionEdgeInfo> {
  const map = new Map<AnchorId, FunctionEdgeInfo>();
  for (const file of files) {
    for (const fn of file.functions) {
      const info = extractFunctionEdgeInfo(fn);
      if (info) map.set(info.anchorId, info);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Phase 2: buildGraph — safe to call after tree.delete()
// ---------------------------------------------------------------------------

/** Build a global name → [AnchorId] multi-map from all functions. */
function buildNameIndex(files: FileNode[]): Map<string, AnchorId[]> {
  const index = new Map<string, AnchorId[]>();
  for (const file of files) {
    for (const fn of file.functions) {
      if (!fn.id) continue;
      const existing = index.get(fn.name);
      if (existing) {
        existing.push(fn.id);
      } else {
        index.set(fn.name, [fn.id]);
      }
    }
  }
  return index;
}

function addEdge(graph: CodeGraph, edge: Edge): void {
  const fwdList = graph.adjacency.get(edge.from);
  if (fwdList) {
    // Dedup inline.
    if (fwdList.some((e) => e.to === edge.to && e.kind === edge.kind)) return;
    fwdList.push(edge);
  } else {
    graph.adjacency.set(edge.from, [edge]);
  }

  const revList = graph.reverseAdjacency.get(edge.to);
  if (revList) {
    revList.push(edge);
  } else {
    graph.reverseAdjacency.set(edge.to, [edge]);
  }

  graph.edges.push(edge);
}

/**
 * Build the in-memory code graph from hashed FileNodes and pre-extracted edge
 * info.
 *
 * @param files     FileNodes whose FunctionNodes all have `id` assigned (T06).
 * @param edgeInfoMap  Optional pre-extracted edge info (from extractEdgeInfo).
 *                    If omitted and bodyAst nodes are still live, edge info is
 *                    extracted automatically. If the trees have been deleted and
 *                    edgeInfoMap is absent, a graph with nodes but no edges is
 *                    returned (safe fallback, with a console warning).
 */
export function buildGraph(
  files: FileNode[],
  edgeInfoMap?: Map<AnchorId, FunctionEdgeInfo>,
): CodeGraph {
  const graph: CodeGraph = {
    nodes: new Map(),
    adjacency: new Map(),
    reverseAdjacency: new Map(),
    edges: [],
    typeRegistry: TypeRegistry.build(files),
  };

  const nameIndex = buildNameIndex(files);

  // Create CodeNode for every function.
  for (const file of files) {
    for (const fn of file.functions) {
      addFunctionNode(graph, fn);
    }
  }

  // Resolve effective edgeInfoMap.
  let effectiveEdgeInfo = edgeInfoMap;
  if (!effectiveEdgeInfo) {
    // Try to extract from live AST. If trees are deleted this will throw
    // "memory access out of bounds" — catch it and fall back gracefully.
    try {
      effectiveEdgeInfo = extractEdgeInfo(files);
    } catch (err) {
      console.warn(
        "[anatomia/graph] buildGraph: could not extract edges from AST " +
          "(tree may have been deleted). Pass edgeInfoMap from extractEdgeInfo() " +
          "to build edges. Graph will have nodes only.\n" +
          String(err),
      );
      return graph; // nodes only, no edges
    }
  }

  emitEdges(graph, effectiveEdgeInfo, nameIndex);
  return graph;
}

/** Add a CodeNode (+ empty adjacency slots) for a hashed FunctionNode. No-op if unhashed. */
function addFunctionNode(graph: CodeGraph, fn: FunctionNode): void {
  if (!fn.id) return;
  const node: CodeNode = {
    id: fn.id,
    name: fn.name,
    kind: "function",
    sourceRange: fn.sourceRange,
  };
  graph.nodes.set(fn.id, node);
  if (!graph.adjacency.has(fn.id)) graph.adjacency.set(fn.id, []);
  if (!graph.reverseAdjacency.has(fn.id)) graph.reverseAdjacency.set(fn.id, []);
}

/**
 * Emit calls/writes/reads edges from edge info, resolving callee/field names via
 * `nameIndex`. Only edges whose source node exists in the graph are emitted.
 * Shared by buildGraph (full build) and augmentGraph (incremental diff overlay).
 */
function emitEdges(
  graph: CodeGraph,
  edgeInfo: Map<AnchorId, FunctionEdgeInfo>,
  nameIndex: Map<string, AnchorId[]>,
): void {
  for (const info of edgeInfo.values()) {
    const fromId = info.anchorId;
    const fromNode = graph.nodes.get(fromId);
    if (!fromNode) continue;
    const callerPath = fromNode.sourceRange.filePath;

    // calls
    for (const call of info.calls) {
      const targets = nameIndex.get(call.name);
      if (!targets) continue;
      const resolved = resolveCall(graph, callerPath, call, info, targets);
      for (const toId of resolved) {
        addEdge(graph, { from: fromId, to: toId, kind: "calls" });
      }
    }

    // writes (emit first to deduplicate reads below)
    for (const fieldName of info.writeFieldNames) {
      const targets = nameIndex.get(fieldName);
      if (!targets) continue;
      for (const toId of localityResolve(graph, callerPath, targets)) {
        addEdge(graph, { from: fromId, to: toId, kind: "writes" });
      }
    }

    // reads (skip if writes edge already covers the same pair)
    for (const fieldName of info.readFieldNames) {
      const targets = nameIndex.get(fieldName);
      if (!targets) continue;
      for (const toId of localityResolve(graph, callerPath, targets)) {
        const alreadyWritten = graph.adjacency
          .get(fromId)
          ?.some((e) => e.to === toId && e.kind === "writes");
        if (!alreadyWritten) {
          addEdge(graph, { from: fromId, to: toId, kind: "reads" });
        }
      }
    }
  }
}

/** Forward-slash a path and return its directory portion (everything before the last `/`). */
function dirOf(filePath: string): string {
  const p = filePath.replace(/\\/g, "/");
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

/**
 * Resolve a call site to its target AnchorId(s).
 *
 * Precedence:
 *   1. TYPE-aware — when the receiver's static type is determined:
 *      - receiver type from parameter / local var / range-for loop var / `this`,
 *        else from a DATA MEMBER of the enclosing class (`hit_.count()`);
 *      - if that type is a KNOWN repo class → restrict to `name` on it or its
 *        bases (empty ⇒ drop, the abstract-interface case, see type-resolve.ts);
 *      - if that type is determined but NOT a repo class → it is external
 *        (`std::unordered_set` etc.) → DROP rather than locality-fan-out to a
 *        same-named repo function (kills false edges like `hit_.count` →
 *        some unrelated `count()`).
 *   2. LOCALITY — unqualified call, or a receiver whose type we cannot determine:
 *      fall back to same-file/same-directory preference (localityResolve).
 */
function resolveCall(
  graph: CodeGraph,
  callerPath: string,
  call: CallSite,
  info: FunctionEdgeInfo,
  targets: AnchorId[],
): AnchorId[] {
  const registry = graph.typeRegistry;
  if (call.receiver !== null && registry) {
    let recvType =
      call.receiver === "this" ? info.selfType : info.symbolTypes[call.receiver];
    // Member-field receiver: a bare identifier that is a field of `this`'s class.
    if (!recvType && info.selfType) {
      recvType = registry.fieldType(info.selfType, call.receiver)?.type ?? undefined;
    }
    if (recvType) {
      if (registry.isKnownType(recvType)) {
        // Known repo type → trust hierarchy resolution, even if empty.
        return registry.resolveMethod(recvType, call.name);
      }
      // Determined but external type → external method, no repo edge.
      return [];
    }
  }
  return localityResolve(graph, callerPath, targets);
}

/**
 * Disambiguate a by-name callee resolution using caller locality.
 *
 * Anatomia resolves a call by bare function name, so a name defined in many
 * places (generic accessors like `alive()`/`position()`/`tick()` that each
 * layer redefines) would otherwise draw an edge to EVERY definition — including
 * ones in unrelated layers, manufacturing false "calls up the layer spine"
 * violations. When a name has multiple candidates we prefer, in order:
 *   1. candidates in the SAME FILE as the caller (a method calling a sibling);
 *   2. else candidates in the SAME DIRECTORY/layer (the .h/.cpp split case);
 *   3. else ALL candidates — a genuinely cross-module call (e.g. a skill calling
 *      a render-only helper) keeps its edge, so real violations still surface.
 *
 * Tradeoff: when the caller's own layer ALSO defines the name, a real call to a
 * different layer's same-named function is collapsed to the local one (a rare
 * false negative). For an advisory architecture linter, fewer false positives
 * (trust) is worth that.
 */
function localityResolve(graph: CodeGraph, callerPath: string, candidates: AnchorId[]): AnchorId[] {
  if (candidates.length <= 1) return candidates;
  const caller = callerPath.replace(/\\/g, "/");
  const callerDir = dirOf(caller);

  const pathOf = (id: AnchorId): string =>
    (graph.nodes.get(id)?.sourceRange.filePath ?? "").replace(/\\/g, "/");

  const sameFile = candidates.filter((id) => pathOf(id) === caller);
  if (sameFile.length > 0) return sameFile;

  const sameDir = candidates.filter((id) => dirOf(pathOf(id)) === callerDir);
  if (sameDir.length > 0) return sameDir;

  return candidates;
}

/**
 * Overlay a diff's new functions onto a copy of an existing graph.
 *
 * verify needs to evaluate architecture rules against the code AS IF the diff
 * were applied: the new functions and the edges from them (resolved against the
 * existing code by name) must be present, or a brand-new violating call is
 * invisible. A full re-`buildGraph` over the whole repo per verify would defeat
 * the warm-server latency budget, so this is incremental:
 *
 *   1. shallow-copy the base graph (new containers, shared node/edge objects);
 *   2. add the diff functions as nodes;
 *   3. resolve the diff functions' outgoing edges against the COMBINED name
 *      index (base names ∪ diff names) and add them.
 *
 * Edges INTO the new functions from existing code are not synthesised (that
 * would require re-walking every existing body); rules over the diff region key
 * off the new functions' OUTGOING edges, which is what this captures.
 *
 * @param base         the analyzed repo graph (unchanged).
 * @param diffFiles    FileNodes for the diff (functions hashed → have `id`).
 * @param diffEdgeInfo edge info for the diff functions (extractEdgeInfo(diffFiles)).
 */
export function augmentGraph(
  base: CodeGraph,
  diffFiles: FileNode[],
  diffEdgeInfo: Map<AnchorId, FunctionEdgeInfo>,
): CodeGraph {
  // Clone the base registry and fold in the diff's types/methods so a call in the
  // diff resolves against existing classes AND any class the diff introduces.
  // (base.typeRegistry is always set by buildGraph; default for hand-built bases.)
  const typeRegistry = (base.typeRegistry ?? new TypeRegistry()).clone();
  typeRegistry.addFiles(diffFiles);

  const graph: CodeGraph = {
    nodes: new Map(base.nodes),
    adjacency: new Map([...base.adjacency].map(([k, v]) => [k, [...v]])),
    reverseAdjacency: new Map([...base.reverseAdjacency].map(([k, v]) => [k, [...v]])),
    edges: [...base.edges],
    typeRegistry,
  };

  // Add diff nodes (a changed function whose id collides with an existing one is
  // the same content → harmless overwrite with identical data).
  for (const file of diffFiles) {
    for (const fn of file.functions) addFunctionNode(graph, fn);
  }

  // Name index over the combined node set so diff calls resolve to existing
  // functions AND to sibling diff functions.
  const nameIndex = new Map<string, AnchorId[]>();
  for (const node of graph.nodes.values()) {
    const existing = nameIndex.get(node.name);
    if (existing) existing.push(node.id);
    else nameIndex.set(node.name, [node.id]);
  }

  emitEdges(graph, diffEdgeInfo, nameIndex);
  return graph;
}
