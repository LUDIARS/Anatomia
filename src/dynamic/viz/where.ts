/**
 * T42 -- You-are-here cursor shaper.
 * buildWhere(frameId, activeZones, cards, phase?) -> WhereLabel
 *
 * Goes to domain/function level from the active zone stack. The optional
 * `phase` (resolved by the T49 classifier from the learned PhaseModel, §5.5)
 * is folded in when supplied; omitting it keeps the cursor at domain/function
 * level with phase=null (backward compatible).
 */
import type { DomainCard } from '../../domains/card.js';
import type { AnchorId } from '../../types.js';

export interface WhereLabel {
  frameId: number;
  /** Domain of the innermost active anchor, or null if not found. */
  domain: string | null;
  /** Innermost active anchor ID, or null if no zones active. */
  functionAnchorId: string | null;
  /** Human-readable: "frame N -> domain=... / function=... [/ phase=...]" */
  label: string;
  /**
   * Learned phase id (T49 classifier), or null when no PhaseModel/phase was
   * supplied. Truncated for display in `label`.
   */
  phase: string | null;
}

/**
 * Build a you-are-here label for the current execution position.
 *
 * @param frameId      Current frame counter.
 * @param activeZones  Ordered active anchor IDs (innermost zone last, LIFO).
 * @param cards        Known domain cards for anchor->domain resolution.
 * @param phase        Resolved phase id (T49), or null (default) for none.
 */
export function buildWhere(
  frameId: number,
  activeZones: string[],
  cards: DomainCard[],
  phase: string | null = null,
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
  const phasePart = phase !== null ? ` / phase=${phase.slice(0, 12)}` : '';
  const label = `frame ${frameId} -> ${domainPart} / ${functionPart}${phasePart}`;

  return {
    frameId,
    domain,
    functionAnchorId: innermostAnchor,
    label,
    phase,
  };
}