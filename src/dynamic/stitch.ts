/**
 * T38 — Join decoded frames with domain cards.
 */
import type { DecodedFrame } from './protocol.js';
import type { DomainCard } from '../domains/card.js';

export interface HotZone {
  anchorId: string;
  domain: string;
  accumulatedUs: number;
}

export interface StitchedFrame {
  frameId: number;
  frameBeginUs: number;
  frameEndUs: number;
  activeDomains: string[];
  hotZone: HotZone | null;
  domainTimes: Record<string, number>;
}

export function stitchFrame(frame: DecodedFrame, cards: DomainCard[]): StitchedFrame {
  const domainTimes: Record<string, number> = {};
  const activeDomainsOrdered: string[] = [];
  const seenDomains = new Set<string>();

  // For each anchorId in activeZoneSet (in order), find which card it belongs to
  for (const anchorId of frame.activeZoneSet) {
    const card = cards.find((c) => c.keyAnchors.includes(anchorId as Parameters<typeof c.keyAnchors.includes>[0]));
    if (!card) continue;

    if (!seenDomains.has(card.domain)) {
      seenDomains.add(card.domain);
      activeDomainsOrdered.push(card.domain);
    }

    // Accumulate zone time into domain total
    const zoneTime = frame.zoneTimes[anchorId] ?? 0;
    domainTimes[card.domain] = (domainTimes[card.domain] ?? 0) + zoneTime;
  }

  // hotZone: anchorId with max zone time (among all anchors in activeZoneSet)
  let hotZone: HotZone | null = null;
  let maxTime = -1;
  for (const anchorId of frame.activeZoneSet) {
    const t = frame.zoneTimes[anchorId] ?? 0;
    if (t > maxTime) {
      const card = cards.find((c) => c.keyAnchors.includes(anchorId as Parameters<typeof c.keyAnchors.includes>[0]));
      maxTime = t;
      hotZone = {
        anchorId,
        domain: card ? card.domain : '',
        accumulatedUs: t,
      };
    }
  }

  return {
    frameId: frame.frameId,
    frameBeginUs: frame.frameBeginUs,
    frameEndUs: frame.frameEndUs,
    activeDomains: activeDomainsOrdered,
    hotZone,
    domainTimes,
  };
}
