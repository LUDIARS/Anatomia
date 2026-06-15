/**
 * T26 — Complexity metrics (game-aware) over the code graph (DESIGN §8).
 *
 * cyclomatic alone is insufficient; game complexity shows up in inter-system
 * coupling and shared-state fan-in. We compute, per node, a set of graph
 * aggregates plus three game-aware metrics:
 *
 *   - domainOverlap   : how many distinct domains touch this node (entity).
 *                         DESIGN §8 "1 entity に触るドメイン数".
 *   - sharedStateFanIn  : fan-in counted only over reads/writes edges into a
 *                         node (= how many functions touch this shared state).
 *   - crossDomainDepth: longest dependency chain (calls/reads/writes) that
 *                         crosses a domain boundary starting at this node.
 *   - cyclomatic        : auxiliary — approximated from the graph as
 *                         (calls out-degree + 1); the body AST is not available
 *                         at this layer so fan-out is used as a proxy.
 *   - fanIn / fanOut    : auxiliary — all-kind incoming / outgoing edges.
 *   - coupling          : auxiliary — fanIn + fanOut (total degree).
 *
 * SRP: this file ONLY computes metrics from a CodeGraphQuery + a domain-
 * membership map. Threshold derivation is thresholds.ts's job.
 *
 * Reuses G2 (CodeGraphQuery) and G3 (DetectionResult.implementors) — no
 * re-implementation of graph traversal or domain detection.
 */

import type { AnchorId } from "../types.js";
import type { CodeGraphQuery } from "../graph/query.js";

/** Per-node complexity metrics. All numbers are non-negative integers. */
export interface NodeMetrics {
  anchor: AnchorId;
  /** Distinct domains whose implementor set contains this node. */
  domainOverlap: number;
  /** Incoming reads+writes edges (= functions touching this shared state). */
  sharedStateFanIn: number;
  /** Longest domain-crossing dependency chain rooted at this node. */
  crossDomainDepth: number;
  /** Auxiliary: approximate cyclomatic complexity (calls out-degree + 1). */
  cyclomatic: number;
  /** Auxiliary: all-kind incoming edges. */
  fanIn: number;
  /** Auxiliary: all-kind outgoing edges. */
  fanOut: number;
  /** Auxiliary: fanIn + fanOut. */
  coupling: number;
}

/**
 * Map of domain name -> the anchors that implement it (DetectionResult-shaped,
 * but decoupled so callers can pass any membership source).
 */
export type DomainMembership = Map<string, AnchorId[]>;

/** Edge kinds that count as touching shared state. */
const STATE_KINDS = ["reads", "writes"] as const;

/** Build anchor -> set-of-domain-names from a membership map. */
function invertMembership(membership: DomainMembership): Map<AnchorId, Set<string>> {
  const byAnchor = new Map<AnchorId, Set<string>>();
  // Sorted domain order keeps the inverted map build deterministic.
  const names = [...membership.keys()].sort();
  for (const name of names) {
    for (const anchor of membership.get(name) ?? []) {
      let set = byAnchor.get(anchor);
      if (!set) {
        set = new Set<string>();
        byAnchor.set(anchor, set);
      }
      set.add(name);
    }
  }
  return byAnchor;
}

/**
 * Longest dependency chain rooted at `start` that crosses at least one domain
 * boundary, measured in edges. A boundary crossing happens when consecutive
 * nodes do not share any domain. Depth-limited DFS over outgoing edges; cycles
 * are guarded with a visited set per path.
 */
async function crossDomainDepth(
  start: AnchorId,
  graph: CodeGraphQuery,
  anchorDomains: Map<AnchorId, Set<string>>,
  maxDepth: number,
): Promise<number> {
  let best = 0;

  async function dfs(
    node: AnchorId,
    depth: number,
    crossed: boolean,
    path: Set<AnchorId>,
  ): Promise<void> {
    if (crossed) best = Math.max(best, depth);
    if (depth >= maxDepth) return;

    const outs = await graph.neighbors(node);
    const nodeMechs = anchorDomains.get(node) ?? new Set<string>();

    for (const next of outs) {
      if (path.has(next.id)) continue; // cycle guard on this path
      const nextMechs = anchorDomains.get(next.id) ?? new Set<string>();
      const shares = [...nodeMechs].some((m) => nextMechs.has(m));
      const nowCrossed = crossed || !shares;
      path.add(next.id);
      await dfs(next.id, depth + 1, nowCrossed, path);
      path.delete(next.id);
    }
  }

  await dfs(start, 0, false, new Set<AnchorId>([start]));
  return best;
}

/**
 * Compute per-node game-aware metrics over the whole graph.
 *
 * @param graph        Code graph (G2 query layer).
 * @param membership   domain name -> implementor anchors (G3 detection).
 * @param maxDepth     Cap on crossDomainDepth DFS (default 16) to bound cost
 *                     on large recursive graphs.
 * @returns NodeMetrics sorted by anchor (deterministic order).
 */
export async function computeMetrics(
  graph: CodeGraphQuery,
  membership: DomainMembership = new Map(),
  maxDepth = 16,
): Promise<NodeMetrics[]> {
  const anchorDomains = invertMembership(membership);
  const nodes = await graph.allNodes();
  const sorted = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const out: NodeMetrics[] = [];
  for (const node of sorted) {
    const all = await graph.fanCounts(node.id);
    const callsOut = await graph.fanCounts(node.id, "calls");

    let stateFanIn = 0;
    for (const kind of STATE_KINDS) {
      stateFanIn += (await graph.fanCounts(node.id, kind)).fanIn;
    }

    const domainOverlap = (anchorDomains.get(node.id) ?? new Set()).size;
    const depth = await crossDomainDepth(node.id, graph, anchorDomains, maxDepth);

    out.push({
      anchor: node.id,
      domainOverlap,
      sharedStateFanIn: stateFanIn,
      crossDomainDepth: depth,
      cyclomatic: callsOut.fanOut + 1,
      fanIn: all.fanIn,
      fanOut: all.fanOut,
      coupling: all.fanIn + all.fanOut,
    });
  }
  return out;
}

/** The numeric metric fields that thresholds.ts derives distributions over. */
export type MetricKey =
  | "domainOverlap"
  | "sharedStateFanIn"
  | "crossDomainDepth"
  | "cyclomatic"
  | "fanIn"
  | "fanOut"
  | "coupling";

export const METRIC_KEYS: MetricKey[] = [
  "domainOverlap",
  "sharedStateFanIn",
  "crossDomainDepth",
  "cyclomatic",
  "fanIn",
  "fanOut",
  "coupling",
];
