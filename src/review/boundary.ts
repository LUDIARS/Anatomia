/**
 * Boundary-drift detection via deterministic label propagation.
 *
 * Question answered: "is this function assigned to the domain its CALL
 * NEIGHBOURHOOD says it belongs to?" — a deterministic, LLM-free signal that a
 * domain boundary is drawn through the wrong place.
 *
 * Phase 1 (propagation): seeds = every domain implementor (multi-membership →
 * lexicographically smallest domain name). Seeds never change. Labels spread to
 * unlabeled nodes over a fixed number of rounds (default 10, early exit when a
 * round changes nothing). Each round processes nodes in anchor lexicographic
 * order and takes the majority label of the calls-neighbourhood (both
 * directions, deduplicated, self-loops excluded); ties resolve to the
 * lexicographically smallest label. No randomness anywhere = fully
 * deterministic (cache contract).
 *
 * Phase 2 (drift): a seed whose neighbourhood majority label (under the final
 * labeling) differs from its assigned domain AND won with >= 2 votes is a
 * boundary-drift finding, with the per-domain vote breakdown as evidence.
 * The >= 2 floor keeps single-neighbour noise out.
 *
 * SRP: propagation + drift decision over CodeGraphQuery × DetectionResults
 * only. Location shaping / report assembly is domain-review.ts's job.
 */

import type { AnchorId } from "../types.js";
import type { CodeGraphQuery } from "../graph/query.js";
import type { DetectionResult } from "../domains/detect.js";

/** One domain's vote count in a node's calls-neighbourhood. */
export interface DriftVote {
  domain: string;
  count: number;
}

/** A seed node whose neighbourhood majority disagrees with its assignment. */
export interface BoundaryDrift {
  anchor: AnchorId;
  /** The domain the detection assigned (seed label). */
  domain: string;
  /** The neighbourhood-majority domain under the final labeling. */
  suggested: string;
  /** Vote breakdown (count desc, then domain asc) — the finding's evidence. */
  votes: DriftVote[];
}

export interface BoundaryDriftOptions {
  /** Propagation rounds (early exit on a no-change round). Default 10. */
  rounds?: number;
}

const DEFAULT_ROUNDS = 10;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Majority label among `neighbors` given the current labeling. Returns null
 * when no neighbour is labeled. Ties resolve to the lexicographically smallest
 * label (deterministic).
 */
function majorityLabel(
  neighbors: readonly AnchorId[],
  labels: ReadonlyMap<AnchorId, string>,
): { label: string; count: number; votes: DriftVote[] } | null {
  const tally = new Map<string, number>();
  for (const n of neighbors) {
    const l = labels.get(n);
    if (l !== undefined) tally.set(l, (tally.get(l) ?? 0) + 1);
  }
  if (tally.size === 0) return null;
  const votes: DriftVote[] = [...tally.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count || cmp(a.domain, b.domain));
  return { label: votes[0]!.domain, count: votes[0]!.count, votes };
}

/**
 * Detect boundary drift over the calls graph. Deterministic: sorted iteration
 * everywhere, no randomness, fixed round count with early exit.
 */
export async function detectBoundaryDrift(
  graph: CodeGraphQuery,
  detections: readonly DetectionResult[],
  opts: BoundaryDriftOptions = {},
): Promise<BoundaryDrift[]> {
  const rounds = opts.rounds ?? DEFAULT_ROUNDS;

  // ── Seeds: implementor -> lexicographically smallest claiming domain ──────
  const seeds = new Map<AnchorId, string>();
  const sortedDetections = [...detections].sort((a, b) => cmp(a.domain, b.domain));
  for (const d of sortedDetections) {
    for (const a of d.implementors) {
      if (!seeds.has(a)) seeds.set(a, d.domain);
    }
  }
  if (seeds.size === 0) return [];

  // ── Undirected, deduplicated calls neighbourhood (self-loops excluded) ─────
  const nodes = await graph.allNodes();
  const sortedIds = nodes.map((n) => n.id).sort(cmp);
  const neighborSets = new Map<AnchorId, Set<AnchorId>>();
  const addNeighbor = (a: AnchorId, b: AnchorId): void => {
    let set = neighborSets.get(a);
    if (!set) {
      set = new Set<AnchorId>();
      neighborSets.set(a, set);
    }
    set.add(b);
  };
  for (const id of sortedIds) {
    for (const e of await graph.edgesFrom(id, "calls")) {
      if (e.from === e.to) continue;
      addNeighbor(e.from, e.to);
      addNeighbor(e.to, e.from);
    }
  }
  // Sorted neighbour lists fix the vote-iteration order.
  const neighborsOf = new Map<AnchorId, AnchorId[]>();
  for (const id of sortedIds) {
    neighborsOf.set(id, [...(neighborSets.get(id) ?? [])].sort(cmp));
  }

  // ── Phase 1: propagate seed labels to unlabeled nodes ─────────────────────
  const labels = new Map<AnchorId, string>(seeds);
  const nonSeeds = sortedIds.filter((id) => !seeds.has(id));
  for (let round = 0; round < rounds; round++) {
    let changed = 0;
    for (const id of nonSeeds) {
      const majority = majorityLabel(neighborsOf.get(id) ?? [], labels);
      if (majority === null) continue;
      if (labels.get(id) !== majority.label) {
        labels.set(id, majority.label);
        changed++;
      }
    }
    if (changed === 0) break;
  }

  // ── Phase 2: seeds disagreeing with their neighbourhood majority ──────────
  const findings: BoundaryDrift[] = [];
  const seedIds = [...seeds.keys()].sort(cmp);
  for (const id of seedIds) {
    const assigned = seeds.get(id)!;
    const majority = majorityLabel(neighborsOf.get(id) ?? [], labels);
    if (majority === null) continue;
    if (majority.label !== assigned && majority.count >= 2) {
      findings.push({ anchor: id, domain: assigned, suggested: majority.label, votes: majority.votes });
    }
  }
  return findings;
}
