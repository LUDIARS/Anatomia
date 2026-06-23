/**
 * src/domains/retune/graph-stats.ts — Mechanical graph statistics (steps' input).
 *
 * Turns an AnalysisContext into the node/dir summaries the re-tune steps reason
 * over: per-function size (composite of cyclomatic + degree), the large/small
 * split, and per-directory aggregates (the natural module candidates).
 *
 * SRP: pure mechanical aggregation over (graph × metrics). No LLM, no I/O, no
 * taxonomy decisions — those live in steps.ts.
 */

import { relative, dirname } from "node:path";
import { computeMetrics } from "../../supply/metrics.js";
import type { AnalysisContext } from "../../core.js";
import type { CodeNode } from "../../types.js";
import type { NodeSummary, DirStat, SizeSplit } from "./types.js";

/** Default percentile (0..1) at/above which a node counts as "large". */
export const DEFAULT_LARGE_PERCENTILE = 0.7;
/** Representatives kept per directory (largest functions, evidence). */
const REPRESENTATIVES_PER_DIR = 5;

/** Repo-relative, forward-slashed path of a node (falls back to raw path). */
function relPathOf(node: CodeNode, repoPath: string): string {
  try {
    return relative(repoPath, node.sourceRange.filePath).replace(/\\/g, "/");
  } catch {
    return node.sourceRange.filePath.replace(/\\/g, "/");
  }
}

/** Composite "size" of a node: structural complexity + graph degree. */
export function nodeSize(cyclomatic: number, fanIn: number, fanOut: number): number {
  return cyclomatic + fanIn + fanOut;
}

/**
 * Summarize every function node in the context: path, dir, metrics, size.
 * Sorted by size descending (largest first).
 */
export async function summarizeNodes(ctx: AnalysisContext): Promise<NodeSummary[]> {
  const metrics = await computeMetrics(ctx.graph, new Map());
  const byAnchor = new Map(metrics.map((m) => [m.anchor, m]));
  const nodes: CodeNode[] = await ctx.graph.allNodes();

  const out: NodeSummary[] = [];
  for (const n of nodes) {
    const m = byAnchor.get(n.id);
    const cyclomatic = m?.cyclomatic ?? 1;
    const fanIn = m?.fanIn ?? 0;
    const fanOut = m?.fanOut ?? 0;
    const relPath = relPathOf(n, ctx.repoPath);
    out.push({
      id: n.id,
      name: n.name,
      relPath,
      dir: dirname(relPath).replace(/\\/g, "/"),
      cyclomatic,
      fanIn,
      fanOut,
      coupling: fanIn + fanOut,
      size: nodeSize(cyclomatic, fanIn, fanOut),
    });
  }
  out.sort((a, b) => b.size - a.size);
  return out;
}

/** The value at the given percentile (0..1) of a numeric list (nearest-rank). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

/**
 * Split nodes into large/small by composite size. A node is "large" when its
 * size is at/above the percentile threshold (default p70).
 */
export function classifyBySize(
  nodes: NodeSummary[],
  p: number = DEFAULT_LARGE_PERCENTILE,
): SizeSplit {
  const threshold = percentile(nodes.map((n) => n.size), p);
  const large: NodeSummary[] = [];
  const small: NodeSummary[] = [];
  for (const n of nodes) {
    if (n.size >= threshold && n.size > 0) large.push(n);
    else small.push(n);
  }
  return { threshold, large, small };
}

/** Aggregate nodes by directory → module candidates, sorted by total size desc. */
export function dirStats(nodes: NodeSummary[]): DirStat[] {
  const byDir = new Map<string, NodeSummary[]>();
  for (const n of nodes) {
    const arr = byDir.get(n.dir) ?? [];
    arr.push(n);
    byDir.set(n.dir, arr);
  }
  const out: DirStat[] = [];
  for (const [dir, arr] of byDir) {
    arr.sort((a, b) => b.size - a.size);
    out.push({
      dir,
      nodeCount: arr.length,
      totalSize: arr.reduce((s, n) => s + n.size, 0),
      representatives: arr.slice(0, REPRESENTATIVES_PER_DIR).map((n) => n.name),
    });
  }
  out.sort((a, b) => b.totalSize - a.totalSize);
  return out;
}
