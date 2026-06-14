/**
 * T42 -- You-are-here cursor shaper.
 * buildWhere(frameId, activeZones, cards) -> WhereLabel
 *
 * Phase learning is DEFERRED per DESIGN SS5.5.
 * This shaper goes only to mechanic/function level.
 */
import type { MechanicCard } from '../../mechanics/card.js';
import type { AnchorId } from '../../types.js';

export interface WhereLabel {
  frameId: number;
  /** Mechanic of the innermost active anchor, or null if not found. */
  mechanic: string | null;
  /** Innermost active anchor ID, or null if no zones active. */
  functionAnchorId: string | null;
  /** Human-readable: "frame N -> mechanic=... / function=..." */
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
 * @param cards        Known mechanic cards for anchor->mechanic resolution.
 */
export function buildWhere(
  frameId: number,
  activeZones: string[],
  cards: MechanicCard[],
): WhereLabel {
  // Innermost zone = last element (LIFO zone-stack convention from ringbuffer)
  const innermostAnchor: string | null = activeZones.at(-1) ?? null;

  let mechanic: string | null = null;
  if (innermostAnchor !== null) {
    for (const card of cards) {
      if (card.keyAnchors.includes(innermostAnchor as AnchorId)) {
        mechanic = card.mechanic;
        break;
      }
    }
  }

  // Truncate anchor to 12 chars for display (matches full anchor if shorter)
  const fnDisplay = innermostAnchor
    ? innermostAnchor.slice(0, 12)
    : null;

  const mechanicPart = mechanic !== null ? `mechanic=${mechanic}` : 'mechanic=?';
  const functionPart = fnDisplay !== null ? `function=${fnDisplay}` : 'function=?';
  const label = `frame ${frameId} -> ${mechanicPart} / ${functionPart}`;

  return {
    frameId,
    mechanic,
    functionAnchorId: innermostAnchor,
    label,
    phase: null,
  };
}