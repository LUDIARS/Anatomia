/**
 * T25 — Link hardening utilities.
 * ratify / mergeLinks / combineEvidence / hardenLoop — confidence + evidence
 * promotion and multi-evidence (noisy-OR) combination.
 */

import type { Link, LinkEvidence } from "../types.js";

// ---------------------------------------------------------------------------
// Evidence priority (higher = better)
// ---------------------------------------------------------------------------

const EVIDENCE_RANK: Record<LinkEvidence, number> = {
  explicit: 3,
  structural: 2,
  semantic: 1,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Promote a link to explicit evidence with confidence 1.0 and mark it
 * as ratified.
 */
export function ratify(link: Link): Link {
  return {
    ...link,
    evidence: "explicit" as LinkEvidence,
    confidence: 1.0,
    ratified: true,
  };
}

/**
 * De-duplicate links by (from, to) pair.
 * When multiple links share the same pair, the winner is chosen by:
 *  1. Highest evidence rank (explicit > structural > semantic).
 *  2. Highest confidence within the same evidence tier.
 */
export function mergeLinks(links: Link[]): Link[] {
  const best = new Map<string, Link>();

  for (const link of links) {
    const key = `${link.from}::${link.to}`;
    const existing = best.get(key);
    if (!existing) {
      best.set(key, link);
      continue;
    }

    const rankNew = EVIDENCE_RANK[link.evidence];
    const rankOld = EVIDENCE_RANK[existing.evidence];

    if (
      rankNew > rankOld ||
      (rankNew === rankOld && link.confidence > existing.confidence)
    ) {
      best.set(key, link);
    }
  }

  return Array.from(best.values());
}

/**
 * De-duplicate links by (from, to) like mergeLinks, but treat INDEPENDENT
 * heuristic evidence as corroborating: when the same pair carries both a
 * structural and a semantic link, the combined confidence is the noisy-OR
 *   1 - (1 - c_structural)(1 - c_semantic)
 * (each source is an independent "detector" of the true link, so the pair is
 * missed only if BOTH miss), and the evidence label keeps the stronger tier.
 * An explicit link still wins outright (mergeLinks priority, confidence 1.0
 * territory — no boosting needed or wanted); duplicates WITHIN one evidence
 * tier are not independent, so only the tier's best confidence enters the OR.
 */
export function combineEvidence(links: Link[]): Link[] {
  const groups = new Map<string, Link[]>();
  for (const link of links) {
    const key = `${link.from}::${link.to}`;
    const group = groups.get(key);
    if (group) group.push(link);
    else groups.set(key, [link]);
  }

  const out: Link[] = [];
  for (const group of groups.values()) {
    const winner = mergeLinks(group)[0]!;
    if (winner.evidence === "explicit") {
      out.push(winner);
      continue;
    }
    // Best confidence per heuristic tier; noisy-OR across tiers when >1.
    const bestByTier = new Map<LinkEvidence, number>();
    for (const l of group) {
      const prev = bestByTier.get(l.evidence);
      if (prev === undefined || l.confidence > prev) bestByTier.set(l.evidence, l.confidence);
    }
    if (bestByTier.size <= 1) {
      out.push(winner);
      continue;
    }
    let missAll = 1;
    for (const c of bestByTier.values()) missAll *= 1 - c;
    out.push({ ...winner, confidence: 1 - missAll });
  }
  return out;
}

/**
 * Iterate links; for each where `ratifyFn` returns true, promote it via
 * `ratify()`.  Returns a new array (input is not mutated).
 */
export function hardenLoop(
  links: Link[],
  ratifyFn: (link: Link) => boolean,
): Link[] {
  return links.map((link) => (ratifyFn(link) ? ratify(link) : link));
}
