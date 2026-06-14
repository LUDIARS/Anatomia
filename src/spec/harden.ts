/**
 * T25 — Link hardening utilities.
 * ratify / mergeLinks / hardenLoop — confidence + evidence promotion.
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
 * Iterate links; for each where `ratifyFn` returns true, promote it via
 * `ratify()`.  Returns a new array (input is not mutated).
 */
export function hardenLoop(
  links: Link[],
  ratifyFn: (link: Link) => boolean,
): Link[] {
  return links.map((link) => (ratifyFn(link) ? ratify(link) : link));
}
