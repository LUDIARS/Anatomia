/**
 * T38 — Join decoded frames with mechanic cards.
 */
import type { DecodedFrame } from './protocol.js';
import type { MechanicCard } from '../mechanics/card.js';

export interface HotZone {
  anchorId: string;
  mechanic: string;
  accumulatedUs: number;
}

export interface StitchedFrame {
  frameId: number;
  frameBeginUs: number;
  frameEndUs: number;
  activeMechanics: string[];
  hotZone: HotZone | null;
  mechanicTimes: Record<string, number>;
}

export function stitchFrame(frame: DecodedFrame, cards: MechanicCard[]): StitchedFrame {
  const mechanicTimes: Record<string, number> = {};
  const activeMechanicsOrdered: string[] = [];
  const seenMechanics = new Set<string>();

  // For each anchorId in activeZoneSet (in order), find which card it belongs to
  for (const anchorId of frame.activeZoneSet) {
    const card = cards.find((c) => c.keyAnchors.includes(anchorId as Parameters<typeof c.keyAnchors.includes>[0]));
    if (!card) continue;

    if (!seenMechanics.has(card.mechanic)) {
      seenMechanics.add(card.mechanic);
      activeMechanicsOrdered.push(card.mechanic);
    }

    // Accumulate zone time into mechanic total
    const zoneTime = frame.zoneTimes[anchorId] ?? 0;
    mechanicTimes[card.mechanic] = (mechanicTimes[card.mechanic] ?? 0) + zoneTime;
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
        mechanic: card ? card.mechanic : '',
        accumulatedUs: t,
      };
    }
  }

  return {
    frameId: frame.frameId,
    frameBeginUs: frame.frameBeginUs,
    frameEndUs: frame.frameEndUs,
    activeMechanics: activeMechanicsOrdered,
    hotZone,
    mechanicTimes,
  };
}
