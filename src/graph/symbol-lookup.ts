import type { AnalysisContext } from "../core.js";
import type { CodeGraphQuery } from "./query.js";
import type { AnchorId, CodeNode, FunctionNode } from "../types.js";

export interface SymbolHit {
  name: string;
  signature: string;
  filePath: string;
  startLine: number;
  endLine: number;
  anchor: AnchorId | null;
  fanIn: number;
  fanOut: number;
}

export interface SymbolLookupOptions {
  mode?: "exact" | "prefix" | "substring";
  limit?: number;
}

const DEFAULT_LIMIT = 20;
const ANCHOR_RE = /^[0-9a-f]{16}$/i;

export function buildSymbolIndex(functions: FunctionNode[]): Map<string, FunctionNode[]> {
  const index = new Map<string, FunctionNode[]>();
  for (const fn of functions) {
    const list = index.get(fn.name);
    if (list) list.push(fn);
    else index.set(fn.name, [fn]);
  }
  for (const list of index.values()) {
    list.sort(compareFunctionLocation);
  }
  return index;
}

export async function findSymbol(
  index: Map<string, FunctionNode[]>,
  graph: CodeGraphQuery,
  name: string,
  opts: SymbolLookupOptions = {},
): Promise<SymbolHit[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const mode = opts.mode ?? "exact";
  let matches = findByMode(index, name, mode);
  if (matches.length === 0 && mode === "exact") {
    matches = findByMode(index, name, "substring");
  }

  const hits = await Promise.all(
    matches
      .sort(compareFunctionLocation)
      .slice(0, limit)
      .map((fn) => functionToHit(fn, graph)),
  );
  return hits;
}

export async function callersOf(
  ctx: AnalysisContext,
  graph: CodeGraphQuery,
  nameOrAnchor: string,
  limit = DEFAULT_LIMIT,
): Promise<SymbolHit[]> {
  const anchors = await resolveAnchors(ctx, graph, nameOrAnchor);
  const byAnchor = functionMap(ctx.functions);
  return neighborHits(
    graph,
    byAnchor,
    anchors,
    (anchor) => graph.predecessors(anchor, "calls"),
    limit,
  );
}

export async function calleesOf(
  ctx: AnalysisContext,
  graph: CodeGraphQuery,
  nameOrAnchor: string,
  limit = DEFAULT_LIMIT,
): Promise<SymbolHit[]> {
  const anchors = await resolveAnchors(ctx, graph, nameOrAnchor);
  const byAnchor = functionMap(ctx.functions);
  return neighborHits(
    graph,
    byAnchor,
    anchors,
    (anchor) => graph.neighbors(anchor, "calls"),
    limit,
  );
}

function findByMode(
  index: Map<string, FunctionNode[]>,
  name: string,
  mode: NonNullable<SymbolLookupOptions["mode"]>,
): FunctionNode[] {
  if (mode === "exact") return [...(index.get(name) ?? [])];

  const needle = name.toLowerCase();
  const out: FunctionNode[] = [];
  for (const [key, fns] of index) {
    const haystack = key.toLowerCase();
    const matched =
      mode === "prefix" ? haystack.startsWith(needle) : haystack.includes(needle);
    if (matched) out.push(...fns);
  }
  return out;
}

async function resolveAnchors(
  ctx: AnalysisContext,
  graph: CodeGraphQuery,
  nameOrAnchor: string,
): Promise<AnchorId[]> {
  if (ANCHOR_RE.test(nameOrAnchor)) {
    const anchor = nameOrAnchor as AnchorId;
    return (await graph.getNode(anchor)) ? [anchor] : [];
  }

  const hits = await findSymbol(buildSymbolIndex(ctx.functions), graph, nameOrAnchor, {
    mode: "exact",
    limit: Number.MAX_SAFE_INTEGER,
  });
  return hits.map((h) => h.anchor).filter((a): a is AnchorId => a !== null);
}

async function neighborHits(
  graph: CodeGraphQuery,
  byAnchor: Map<AnchorId, FunctionNode>,
  anchors: AnchorId[],
  load: (anchor: AnchorId) => Promise<CodeNode[]>,
  limit: number,
): Promise<SymbolHit[]> {
  const seen = new Set<AnchorId>();
  const nodes: CodeNode[] = [];
  for (const anchor of anchors) {
    for (const node of await load(anchor)) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      nodes.push(node);
    }
  }

  const hits = await Promise.all(
    nodes
      .sort(compareCodeNodeLocation)
      .slice(0, limit)
      .map((node) => nodeToHit(node, byAnchor.get(node.id), graph)),
  );
  return hits;
}

async function functionToHit(fn: FunctionNode, graph: CodeGraphQuery): Promise<SymbolHit> {
  if (!fn.id) {
    return {
      name: fn.name,
      signature: fn.signature,
      filePath: fn.sourceRange.filePath,
      startLine: fn.sourceRange.start.line,
      endLine: fn.sourceRange.end.line,
      anchor: null,
      fanIn: 0,
      fanOut: 0,
    };
  }

  return nodeToHit(
    {
      id: fn.id,
      name: fn.name,
      kind: "function",
      sourceRange: fn.sourceRange,
    },
    fn,
    graph,
  );
}

async function nodeToHit(
  node: CodeNode,
  fn: FunctionNode | undefined,
  graph: CodeGraphQuery,
): Promise<SymbolHit> {
  const counts = await graph.fanCounts(node.id, "calls");
  const range = fn?.sourceRange ?? node.sourceRange;
  return {
    name: fn?.name ?? node.name,
    signature: fn?.signature ?? "",
    filePath: range.filePath,
    startLine: range.start.line,
    endLine: range.end.line,
    anchor: node.id,
    fanIn: counts.fanIn,
    fanOut: counts.fanOut,
  };
}

function functionMap(functions: FunctionNode[]): Map<AnchorId, FunctionNode> {
  const out = new Map<AnchorId, FunctionNode>();
  for (const fn of functions) {
    if (fn.id) out.set(fn.id, fn);
  }
  return out;
}

function compareFunctionLocation(a: FunctionNode, b: FunctionNode): number {
  return (
    a.sourceRange.filePath.localeCompare(b.sourceRange.filePath) ||
    a.sourceRange.start.line - b.sourceRange.start.line ||
    a.name.localeCompare(b.name)
  );
}

function compareCodeNodeLocation(a: CodeNode, b: CodeNode): number {
  return (
    a.sourceRange.filePath.localeCompare(b.sourceRange.filePath) ||
    a.sourceRange.start.line - b.sourceRange.start.line ||
    a.name.localeCompare(b.name)
  );
}
