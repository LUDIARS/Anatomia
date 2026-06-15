/**
 * T42 -- You-are-here cursor shaper.
 * buildWhere(frameId, activeZones, cards) -> WhereLabel
 *
 * Phase learning is DEFERRED per DESIGN SS5.5.
 * This shaper goes only to domain/function level.
 */
import type { DomainCard } from '../../domains/card.js';
import type { AnchorId } from '../../types.js';

export interface WhereLabel {
  frameId: number;
  /** Domain of the innermost active anchor, or null if not found. */
  domain: string | null;
  /** Innermost active anchor ID, or null if no zones active. */
  functionAnchorId: string | null;
  /** Human-readable: "frame N -> domain=... / function=..." */
  label: string;
  /**
   * Phase is intentionally null -- deferred per DESIGN SS5.5.
   */
  phase: null;
}

/**
 * Build a you-are-here label for the current execution position.
 *
 * @param frameId      Current frame counter.
 * @param activeZones  Ordered active anchor IDs (innermost zone last, LIFO).
 * @param cards        Known domain cards for anchor->domain resolution.
 */
export function buildWhere(
  frameId: number,
  activeZones: string[],
  cards: DomainCard[],
): WhereLabel {
  // Innermost zone = last element (LIFO zone-stack convention from ringbuffer)
  const innermostAnchor: string | null = activeZones.at(-1) ?? null;

  let domain: string | null = null;
  if (innermostAnchor !== null) {
    for (const card of cards) {
      if (card.keyAnchors.includes(innermostAnchor as AnchorId)) {
        domain = card.domain;
        break;
      }
    }
  }

  // Truncate anchor to 12 chars for display (matches full anchor if shorter)
  const fnDisplay = innermostAnchor
    ? innermostAnchor.slice(0, 12)
    : null;

  const domainPart = domain !== null ? `domain=${domain}` : 'domain=?';
  const functionPart = fnDisplay !== null ? `function=${fnDisplay}` : 'function=?';
  const label = `frame ${frameId} -> ${domainPart} / ${functionPart}`;

  return {
    frameId,
    domain,
    functionAnchorId: innermostAnchor,
    label,
    phase: null,
  };
}