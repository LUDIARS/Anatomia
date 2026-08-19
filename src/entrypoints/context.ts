/**
 * src/entrypoints/context.ts — `nearestEntries` for the context bundle.
 *
 * A supply bundle answers "where does new code land"; this answers the follow-up
 * an agent actually needs — "from which product entry does that landing point
 * get exercised". Deriving the whole entry graph per bundle would be wasteful, so
 * the graph is memoised per AnalysisContext + entrypoint-config revision. The
 * latter matters because the project fingerprint intentionally prunes
 * `.anatomia`.
 *
 * SRP: the landing-anchor → nearest entries query only.
 */

import type { AnalysisContext } from "../core.js";
import type { AnchorId } from "../types.js";
import { computeEntryPointConfigRevision } from "./config.js";
import { detectEntryPoints } from "./detect.js";
import { deriveEntryPointGraph } from "./derive.js";
import { buildColoring } from "./coloring.js";
import type { EntryPointGraph, NearestEntry } from "./types.js";

interface MemoizedGraph {
  configRevision: string;
  pending: Promise<EntryPointGraph>;
}

const memo = new WeakMap<AnalysisContext, MemoizedGraph>();

/** The entry graph for this context/config revision, derived at most once. */
export async function entryPointGraphFor(ctx: AnalysisContext): Promise<EntryPointGraph> {
  const configRevision = await computeEntryPointConfigRevision(ctx.repoPath);
  const cached = memo.get(ctx);
  if (cached?.configRevision === configRevision) return cached.pending;
  const pending = (async () => deriveEntryPointGraph({
    projectId: "context",
    sourceRevision: "context",
    context: ctx,
    manifest: await detectEntryPoints(ctx),
    coloring: buildColoring(ctx),
  }))();
  memo.set(ctx, { configRevision, pending });
  try {
    return await pending;
  } catch (error) {
    if (memo.get(ctx)?.pending === pending) memo.delete(ctx);
    throw error;
  }
}

/**
 * Entries that reach `anchor`, nearest first (distance, then anchor). At most
 * `limit` (the bundle carries a hint, not an inventory).
 */
export async function nearestEntriesFor(
  ctx: AnalysisContext,
  anchor: AnchorId | null,
  limit = 3,
): Promise<NearestEntry[]> {
  if (anchor === null) return [];
  const graph = await entryPointGraphFor(ctx);
  const node = graph.nodes.find((candidate) => candidate.anchor === String(anchor));
  if (!node) return [];
  const summaries = new Map(graph.entries.map((entry) => [entry.id, entry]));
  return node.reachedFrom
    .map((entryId) => ({ entryId, distance: node.distance[entryId] ?? 0, summary: summaries.get(entryId) }))
    .filter((row): row is { entryId: string; distance: number; summary: NonNullable<typeof row.summary> } => !!row.summary)
    .sort((left, right) => left.distance - right.distance || left.entryId.localeCompare(right.entryId))
    .slice(0, limit)
    .map((row) => ({
      entryId: row.entryId,
      classes: row.summary.classes,
      name: row.summary.symbol.name,
      path: row.summary.symbol.path,
      distance: row.distance,
    }));
}
