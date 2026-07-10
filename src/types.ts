/**
 * Core types for Anatomia (T02).
 * Types only — no logic, no circular imports.
 * The AstNode placeholder is filled by T03 (web-tree-sitter integration).
 */

// ---------------------------------------------------------------------------
// Branded primitives
// ---------------------------------------------------------------------------

/** Normalized Merkle hash of a function body (α-normalized). Filled by T06. */
export type AnchorId = string & { readonly __brand: "AnchorId" };

// ---------------------------------------------------------------------------
// AST node (web-tree-sitter, T03)
// ---------------------------------------------------------------------------

/** Zero-based row/column position (mirrors web-tree-sitter `Point`). */
export interface AstPoint {
  row: number;
  column: number;
}

/**
 * The READ-ONLY syntax-node surface the analysis pipeline relies on.
 *
 * Historically this was a bare alias for web-tree-sitter's `Node`, whose
 * children are backed by the parser's emscripten heap (capped at 2GB). Holding
 * a whole repository's `Node`s alive across analysis phases exhausted that heap
 * on large repos and poisoned the shared WASM module (DESIGN / task #335).
 *
 * It is now a structural interface so that a function body can be DETACHED from
 * the native tree into a plain-JS mirror (`freezeBody`, dag/freeze.ts) the
 * moment it is extracted — letting `tree.delete()` run per-file instead of
 * per-repo. The real `Node` still satisfies this interface, so live nodes (e.g.
 * a freshly-parsed template pattern) remain assignable wherever `AstNode` is
 * expected. Only the members actually consumed downstream are declared here;
 * keep this surface minimal so both the live `Node` and the frozen mirror stay
 * cheap to satisfy.
 */
export interface AstNode {
  readonly type: string;
  readonly text: string;
  readonly startIndex: number;
  readonly startPosition: AstPoint;
  readonly endPosition: AstPoint;
  readonly isNamed: boolean;
  readonly isExtra: boolean;
  readonly parent: AstNode | null;
  readonly children: (AstNode | null)[];
  readonly namedChildren: (AstNode | null)[];
  readonly childCount: number;
  child(index: number): AstNode | null;
  childForFieldName(fieldName: string): AstNode | null;
  childrenForFieldName(fieldName: string): (AstNode | null)[];
  descendantsOfType(type: string): (AstNode | null)[];
}

/** Supported source languages (tree-sitter grammar identifiers). */
export type Lang = "cpp" | "c_sharp" | "typescript" | "tsx";

// ---------------------------------------------------------------------------
// Source location
// ---------------------------------------------------------------------------

export interface SourcePosition {
  line: number;
  column: number;
}

export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
  /** Absolute path to the source file. */
  filePath: string;
}

// ---------------------------------------------------------------------------
// Static DAG nodes (G1)
// ---------------------------------------------------------------------------

/** A formal parameter: binding name + simple (un-qualified) type name. */
export interface ParamInfo {
  /** Parameter binding identifier. */
  name: string;
  /**
   * Simple type name (namespace/qualifiers/`const`/`&`/`*` stripped, e.g.
   * `const combat::HitReceiver&` → `HitReceiver`). `null` for primitive or
   * unresolvable types (those can never name a class, so type resolution skips
   * them).
   */
  type: string | null;
  /**
   * For a single-argument container template (`std::vector<IDamageReceiver*>`),
   * the simple element type (`IDamageReceiver`). Lets a `for (auto* r : param)`
   * range-loop type its loop variable. `null` when the type is not such a
   * template.
   */
  elementType?: string | null;
}

/** A function or method extracted from source. */
export interface FunctionNode {
  /** Filled by T06 after normalization + hashing. Null before hash step. */
  id: AnchorId | null;
  /**
   * Path-INDEPENDENT structural hash (normalized body + signature shape, NO file
   * path). Two identical functions in different files share this hash even though
   * their `id` (which folds the file path) differs — so it identifies structural
   * clones. Filled alongside `id` by assignAnchorId.
   */
  structuralHash?: string;
  name: string;
  /** Full signature text (return type + params). */
  signature: string;
  /**
   * Simple name of the class/struct/interface this is a method of, when the
   * extractor can determine it (in-class definition, `Class::method` out-of-line
   * definition, or C# member). `undefined` for free functions. Drives type-aware
   * call resolution (`this`/member-call receiver typing). See graph/type-resolve.
   */
  enclosingType?: string;
  /** Parameters with their simple type names (drives receiver typing). */
  params?: ParamInfo[];
  /**
   * Simple return type name, used to type `auto x = recv.method()` locals.
   * `null`/`undefined` for primitive/void/constructor returns.
   */
  returnType?: string | null;
  /** Element type when the return is a single-arg container template. */
  returnElementType?: string | null;
  sourceRange: SourceRange;
  /** Raw AST subtree for this function body. */
  bodyAst: AstNode;
}

/**
 * A declared class/struct/interface and its (simple-named) base types.
 * Captured independently of method bodies so an abstract interface whose methods
 * are all pure-virtual (no FunctionNode) is still a *known type* — that lets
 * type resolution treat a call through such an interface as resolved-to-nothing
 * (no fan-out to every concrete override) rather than an ambiguous name.
 */
export interface TypeDecl {
  /** Simple type name. */
  name: string;
  /** Simple names of direct base classes / interfaces. */
  bases: string[];
  /**
   * Data members (fields/properties) with their simple type names. Lets a bare
   * member-field receiver (`hit_.count()` inside a method) be typed via the
   * enclosing class. Only members whose type names a class (or a container with
   * a class element) are recorded.
   */
  fields?: FieldInfo[];
  /** Absolute path of the declaring file (diagnostics only). */
  filePath: string;
}

/** A data member: field name + simple type (and container element type). */
export interface FieldInfo {
  name: string;
  /** Simple class type name, or null when not a class type. */
  type: string | null;
  /** Element type when the field is a single-arg container template. */
  elementType?: string | null;
}

/** A source file modelled as a Merkle node over its function set. */
export interface FileNode {
  /** Absolute path. */
  path: string;
  /** Merkle hash of this file (hash of sorted child function hashes). Filled by T07. */
  hash: string | null;
  /**
   * SHA-256 of the file's raw source bytes. Distinct from `hash` (a Merkle hash
   * over function structure): this keys the per-file analysis reuse in analyze()
   * — an unchanged file's whole FileNode (with its detached bodyAst mirrors) is
   * reused as-is, skipping parse/extract. Filled in analyze(); optional so
   * hand-built FileNodes can omit it.
   */
  contentHash?: string;
  functions: FunctionNode[];
  /**
   * Class/struct/interface declarations in this file. Metadata for type-aware
   * call resolution — NOT folded into the Merkle hash (which is over function
   * bodies only). Optional so callers that build a FileNode by hand can omit it.
   */
  types?: TypeDecl[];
}

// ---------------------------------------------------------------------------
// Code graph (G2)
// ---------------------------------------------------------------------------

export type EdgeKind =
  | "calls"
  | "depends"
  | "reads"
  | "writes"
  | "implements"
  | "overrides"
  | "includes";

export type NodeKind = "function" | "method" | "class" | "module" | "file";

export interface CodeNode {
  id: AnchorId;
  name: string;
  kind: NodeKind;
  sourceRange: SourceRange;
  /**
   * Optional classification tags (e.g. "hotPath", "alloc", layer names).
   * Used by the domains rule engine's NodeFilter (G3, DESIGN §4.3).
   * Tagging is supplied externally (domain ontology / heuristics); the static
   * DAG layer does not assign tags.
   */
  tags?: string[];
}

export interface Edge {
  from: AnchorId;
  to: AnchorId;
  kind: EdgeKind;
}

/**
 * Why a call edge was dropped during resolution (graph/build.ts). Mirrors the
 * resolveCall / emitEdges precedence order:
 *   - "abstract-no-impl"    : receiver's type is a known repo class but no body
 *                             for the method exists in its hierarchy (the
 *                             pure-virtual interface / dependency-inversion case);
 *   - "external-type"       : receiver's type is determined but is NOT a repo
 *                             class (std:: containers etc.);
 *   - "unresolved-receiver" : receiver present but its type could not be
 *                             determined, and no same-file/same-dir candidate;
 *   - "no-local-candidate"  : callee name has no definition anywhere in the
 *                             analyzed code (stdlib / external free call).
 */
export type UnresolvedReason =
  | "abstract-no-impl"
  | "external-type"
  | "unresolved-receiver"
  | "no-local-candidate";

/**
 * A call site whose edge was DROPPED by static resolution rather than emitted.
 * The static layer prefers false-negative drops over phantom edges (build.ts
 * header); this record keeps the drop auditable and gives the dynamic layer a
 * join key to later re-confirm the edge from observed traces
 * (spec/feature/dynamic-edge-recovery.md).
 */
export interface UnresolvedCall {
  /** Caller function's anchor. */
  from: AnchorId;
  /** Terminal callee name at the call site (`obj.method()` → `method`). */
  calleeName: string;
  /** Receiver's resolved static type, when it was determined before the drop. */
  receiverType?: string;
  reason: UnresolvedReason;
}

// ---------------------------------------------------------------------------
// Architecture rules (G3, DESIGN §4.3)
// ---------------------------------------------------------------------------

export type RuleSeverity = "block" | "warn";
export type RuleScope = "global" | "domain";

/**
 * Severity attached to a concrete violation (distinct from a Rule's
 * block/warn gate severity). Mirrors common linter levels.
 */
export type ViolationSeverity = "error" | "warning" | "info";

// ── Predicate ADT (T14) ────────────────────────────────────────────────────

/**
 * A NodeFilter matches CodeNodes by kind, name (regex), source-path (regex)
 * and/or tags. All present fields are ANDed. An empty filter matches every node.
 */
export interface NodeFilter {
  /** Match nodes of this kind. */
  kind?: NodeKind;
  /** Match nodes whose name matches this regex (JS RegExp source). */
  namePattern?: string;
  /**
   * Match nodes whose source file path matches this regex (JS RegExp source).
   * Tested against the path normalised to forward slashes, so a pattern like
   * `/enemy/` matches regardless of OS path separator. This is the lever for
   * directory-based architecture rules (layer = location).
   */
  pathPattern?: string;
  /** Match nodes that carry ALL of these tags. */
  tags?: string[];
}

/**
 * Concrete, serializable predicate representation (discriminated union).
 * Evaluated by evaluatePredicate() in domains/engine.ts (T14).
 *
 * This replaces the scaffold's opaque `Rule.predicate: unknown`.
 */
export type Predicate =
  /** No edge of `kind` may exist between a `from`-match and a `to`-match. */
  | { type: "EdgeForbidden"; from: NodeFilter; to: NodeFilter; kind: EdgeKind }
  /** Fan-in (incoming edges, optionally of `kind`) of each target ≤ max. */
  | { type: "FanInCap"; target: NodeFilter; max: number; kind?: EdgeKind }
  /** Fan-out (outgoing edges, optionally of `kind`) of each target ≤ max. */
  | { type: "FanOutCap"; target: NodeFilter; max: number; kind?: EdgeKind }
  /** No cycle may exist among nodes matching `scope` (following `kind`). */
  | { type: "NoCycle"; scope: NodeFilter; kind?: EdgeKind }
  /** References a template rule (compiled in T16). */
  | { type: "TemplatePredicate"; templateId: string }
  | { type: "And"; children: Predicate[] }
  | { type: "Or"; children: Predicate[] }
  | { type: "Not"; child: Predicate };

/**
 * An architectural rule (DESIGN §4.3): scope + concrete predicate + gate
 * severity.
 */
export interface Rule {
  id: string;
  scope: RuleScope;
  /** Human-readable description. */
  description: string;
  /** Concrete, serializable predicate (T14). */
  predicate: Predicate;
  severity: RuleSeverity;
}

/**
 * A concrete rule violation (T14). `anchors` lists every code anchor involved;
 * `evidence` is a human-readable explanation string.
 */
export interface Violation {
  ruleId: string;
  /** All code anchors involved in this violation. */
  anchors: AnchorId[];
  /** Human-readable evidence / explanation. */
  evidence: string;
  severity: ViolationSeverity;
}

// ---------------------------------------------------------------------------
// Code ↔ Spec linking (G4, DESIGN §4.5)
// ---------------------------------------------------------------------------

export type LinkEvidence = "explicit" | "structural" | "semantic";

/** A parsed clause from a spec document (e.g. a §-section or bullet). */
export interface SpecClause {
  id: string;
  /** Source file (spec/*.md, DESIGN.md, …). */
  sourceFile: string;
  /** Section heading path, e.g. "§4.5 / リンカ". */
  heading: string;
  /** Raw text of the clause. */
  text: string;
  /** Embedding vector placeholder; filled by T24. */
  embedding: number[] | null;
}

/** A directional link between a code anchor and a spec clause. */
export interface Link {
  from: AnchorId;
  to: string; // SpecClause.id
  confidence: number; // 0.0–1.0
  evidence: LinkEvidence;
  /** True once a human or automated gate has ratified this link. */
  ratified?: boolean;
}

// ---------------------------------------------------------------------------
// Supply / Verify (G5, DESIGN §9.1)
// ---------------------------------------------------------------------------

/**
 * A deterministic context bundle passed to AI before code generation.
 * `orderSegments` (llm-gateway) arranges immutable-first, mutable-last.
 */
export interface ContextBundle {
  /** Target anchor where new code should land. */
  landingAnchor: AnchorId | null;
  /** Rules that apply: global ∪ domain-specific. */
  applicableRules: Rule[];
  /** Spec clauses linked to the landing anchor. */
  specClauses: SpecClause[];
  /** Example sibling functions that define local conventions. */
  exemplars: FunctionNode[];
  /** KG-derived set of anchors that could be affected by changes here. */
  impactRadius: AnchorId[];
  /** Existing domains that subsume this task (duplication guard). */
  existingDomains: string[];
}

/** A gate within the verify step. */
export interface GateResult {
  gate:
    | "rule_conformance"
    | "duplication"
    | "spec_linkage"
    | "coupling_delta"
    | "convention_drift";
  pass: boolean;
  anchors: AnchorId[];
  /** Human-readable suggestion for fixing the failure. */
  suggestion: string | null;
}

/** Structured verdict returned by verify (DESIGN §9.1 ③). */
export interface Verdict {
  /** Overall pass only when all `block`-severity gates pass. */
  pass: boolean;
  gates: GateResult[];
  /** All anchors directly involved in violations. */
  anchors: AnchorId[];
  /** Top-level suggestion summarising required fixes. */
  suggestion: string | null;
}
