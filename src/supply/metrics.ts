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
 * Longest dependency chain that crosses at least one domain boundary, for
 * EVERY node at once, measured in edges. A boundary crossing happens when
 * consecutive nodes do not share any domain.
 *
 * Implementation note (task: low-memory analyze follow-up): this used to be a
 * per-node DFS that enumerated every simple path (per-path cycle guard) up to
 * maxDepth. That is exponential in out-degree — on a real game repo (51k
 * functions, 1.2M edges, avg out-degree ~23) a SINGLE node's enumeration never
 * finishes, and it ran per node. Replaced with one memoized post-order pass
 * over the whole graph, O(V+E):
 *
 *   L(n) = longest chain from n
 *   C(n) = longest chain from n containing ≥1 crossing edge (-1 = none)
 *        = max over edges n→m of:  crossing(n,m) ? 1+L(m) : (C(m)≥0 ? 1+C(m) : -1)
 *
 * Cycles are cut after the back-edge itself: an on-stack target contributes a
 * terminal one-edge path but is not traversed again. This preserves direct
 * domain crossings inside recursive components without reintroducing the old
 * exponential simple-path enumeration. Results are clamped to maxDepth,
 * matching the old exploration cap.
 */
async function computeCrossDomainDepths(
  graph: CodeGraphQuery,
  anchorDomains: Map<AnchorId, Set<string>>,
  maxDepth: number,
  sortedIds: readonly AnchorId[],
): Promise<Map<AnchorId, number>> {
  // Collect adjacency once (async boundary), then walk synchronously.
  const adjacency = new Map<AnchorId, AnchorId[]>();
  for (const id of sortedIds) {
    adjacency.set(id, (await graph.neighbors(id)).map((n) => n.id));
  }
  const empty = new Set<string>();
  const crossing = (from: AnchorId, to: AnchorId): boolean => {
    const a = anchorDomains.get(from) ?? empty;
    const b = anchorDomains.get(to) ?? empty;
    for (const m of a) if (b.has(m)) return false;
    return true;
  };

  const longest = new Map<AnchorId, number>();
  const crossed = new Map<AnchorId, number>();
  /** 1 = on the explicit DFS stack, 2 = memoized. */
  const state = new Map<AnchorId, 1 | 2>();

  for (const start of sortedIds) {
    if (state.has(start)) continue;
    const stack: { node: AnchorId; childIndex: number }[] = [{ node: start, childIndex: 0 }];
    state.set(start, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const outs = adjacency.get(frame.node) ?? [];
      if (frame.childIndex < outs.length) {
        const next = outs[frame.childIndex++]!;
        if (!state.has(next)) {
          state.set(next, 1);
          stack.push({ node: next, childIndex: 0 });
        }
        // on-stack (cycle) or memoized → nothing to descend into
        continue;
      }
      // Post-order: children that finished are memoized; back-edges are cut.
      let bestL = 0;
      let bestC = -1;
      for (const next of outs) {
        if (state.get(next) === 1) {
          // Keep the back-edge as a terminal edge. Dropping it altogether
          // makes a recursive pair in different domains report no crossing.
          bestL = Math.max(bestL, 1);
          if (crossing(frame.node, next)) bestC = Math.max(bestC, 1);
          continue;
        }
        if (state.get(next) !== 2) continue;
        const lNext = longest.get(next) ?? 0;
        const cNext = crossed.get(next) ?? -1;
        if (1 + lNext > bestL) bestL = 1 + lNext;
        if (crossing(frame.node, next)) {
          if (1 + lNext > bestC) bestC = 1 + lNext;
        } else if (cNext >= 0 && 1 + cNext > bestC) {
          bestC = 1 + cNext;
        }
      }
      longest.set(frame.node, bestL);
      crossed.set(frame.node, bestC);
      state.set(frame.node, 2);
      stack.pop();
    }
  }

  const out = new Map<AnchorId, number>();
  for (const id of sortedIds) {
    out.set(id, Math.min(maxDepth, Math.max(0, crossed.get(id) ?? -1)));
  }
  return out;
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
  const sortedIds = sorted.map((n) => n.id);
  const depths = await computeCrossDomainDepths(graph, anchorDomains, maxDepth, sortedIds);

  const out: NodeMetrics[] = [];
  for (const node of sorted) {
    const all = await graph.fanCounts(node.id);
    const callsOut = await graph.fanCounts(node.id, "calls");

    let stateFanIn = 0;
    for (const kind of STATE_KINDS) {
      stateFanIn += (await graph.fanCounts(node.id, kind)).fanIn;
    }

    const domainOverlap = (anchorDomains.get(node.id) ?? new Set()).size;

    out.push({
      anchor: node.id,
      domainOverlap,
      sharedStateFanIn: stateFanIn,
      crossDomainDepth: depths.get(node.id) ?? 0,
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
