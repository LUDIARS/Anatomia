/**
 * src/graph/traverse.ts — The one reachability traversal over the code graph.
 *
 * Scene derivation (scenes/derive.ts, knowledge/scene/derive.ts) and the
 * entry-point trace graph (entrypoints/derive.ts) all answer the same question:
 * "starting from this entry set, which functions does control reach?". They used
 * to each carry their own BFS; spec/feature/entrypoint-trace-graph.md 不変条件 6
 * requires a single traversal implementation, so this module owns it and the
 * others call in.
 *
 * The walk is level-synchronous, which is what makes `distance` the true minimum
 * hop count. `via` (the parent on a shortest path) is tie-broken by ascending
 * anchor so the same graph always yields the same tree — a byte-identical
 * artifact is only possible if the traversal itself is deterministic.
 *
 * SRP: traversal only. No domain colouring, no persistence, no formatting.
 */

import type { CodeGraphQuery } from "./query.js";
import type { AnchorId, EdgeKind } from "../types.js";

/** How one reached node was first arrived at. */
export interface ReachStep {
  /** Minimum number of hops from the entry set (0 for an entry itself). */
  distance: number;
  /** Parent on the shortest path; null for an entry. Ties break on lowest anchor. */
  via: AnchorId | null;
  /** Edge kind traversed from `via`; null for an entry. */
  viaKind: EdgeKind | null;
}

export interface ReachOptions {
  /** Edge kinds to follow. Default: `["calls"]` (control flow only). */
  edgeKinds?: readonly EdgeKind[];
  /** Maximum hop count. Default: unlimited. */
  maxDepth?: number;
}

export interface ReachResult {
  /** Entry set ∪ reachable, each with its distance + shortest-path parent. */
  steps: Map<AnchorId, ReachStep>;
  /** True when the walk stopped at `maxDepth` with unexpanded nodes remaining. */
  depthLimited: boolean;
}

const DEFAULT_EDGE_KINDS: readonly EdgeKind[] = ["calls"];

/**
 * Level-synchronous BFS from the whole entry set at once (one traversal, not one
 * per entry). Returns entries ∪ reachable with distance + via.
 */
export async function reachFrom(
  graph: CodeGraphQuery,
  entries: readonly AnchorId[],
  options: ReachOptions = {},
): Promise<ReachResult> {
  const edgeKinds = [...new Set(options.edgeKinds ?? DEFAULT_EDGE_KINDS)].sort();
  const steps = new Map<AnchorId, ReachStep>();
  for (const anchor of [...new Set(entries)].sort()) steps.set(anchor, { distance: 0, via: null, viaKind: null });

  let frontier = [...steps.keys()];
  let depth = 0;
  let depthLimited = false;
  while (frontier.length > 0) {
    // Parent per newly-seen node, lowest anchor wins (the deterministic tie-break).
    const parents = new Map<AnchorId, { via: AnchorId; kind: EdgeKind }>();
    for (const anchor of frontier) {
      for (const kind of edgeKinds) {
        for (const neighbour of await graph.neighbors(anchor, kind)) {
          if (steps.has(neighbour.id)) continue;
          const current = parents.get(neighbour.id);
          if (current === undefined || anchor < current.via) parents.set(neighbour.id, { via: anchor, kind });
        }
      }
    }
    const next = [...parents.keys()].sort();
    if (next.length === 0) break;
    if (options.maxDepth !== undefined && depth + 1 > options.maxDepth) {
      depthLimited = true;
      break;
    }
    for (const anchor of next) {
      const parent = parents.get(anchor)!;
      steps.set(anchor, { distance: depth + 1, via: parent.via, viaKind: parent.kind });
    }
    frontier = next;
    depth += 1;
  }
  return { steps, depthLimited };
}

/**
 * Entries ∪ everything reachable from them. The shape scene derivation wants
 * (it attributes by membership, not by distance).
 */
export async function reachClosure(
  graph: CodeGraphQuery,
  entries: readonly AnchorId[],
  maxDepth?: number,
): Promise<Set<AnchorId>> {
  const { steps } = await reachFrom(graph, entries, maxDepth === undefined ? {} : { maxDepth });
  return new Set(steps.keys());
}
