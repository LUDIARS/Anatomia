/**
 * T40 -- Frame x mechanic timeline shaper.
 * buildTimeline(stitchedFrames, window) -> TimelineData
 */
import type { StitchedFrame } from '../stitch.js';

export interface TimelineBar {
  mechanic: string;
  durationUs: number;
}

export interface TimelineFrame {
  frameId: number;
  frameBeginUs: number;
  frameEndUs: number;
  /** Ordered bars (same order as activeMechanics in the stitched frame). */
  bars: TimelineBar[];
  /** Total frame wall-clock duration in us. */
  totalUs: number;
}

export interface TimelineData {
  frames: TimelineFrame[];
  /** All unique mechanic names that appear in this window. */
  mechanics: string[];
}

/**
 * Produce timeline data from a window of stitched frames.
 *
 * @param stitchedFrames  Source frames from TraceSource.recentFrames().
 * @param window          Max number of frames to include (last N). Omit for all.
 */
export function buildTimeline(
  stitchedFrames: StitchedFrame[],
  window?: number,
): TimelineData {
  const source =
    window !== undefined && window < stitchedFrames.length
      ? stitchedFrames.slice(-window)
      : stitchedFrames;

  const mechanicSet = new Set<string>();

  const frames: TimelineFrame[] = source.map((sf) => {
    const bars: TimelineBar[] = sf.activeMechanics.map((m) => {
      mechanicSet.add(m);
      return { mechanic: m, durationUs: sf.mechanicTimes[m] ?? 0 };
    });
    return {
      frameId: sf.frameId,
      frameBeginUs: sf.frameBeginUs,
      frameEndUs: sf.frameEndUs,
      bars,
      totalUs: sf.frameEndUs - sf.frameBeginUs,
    };
  });

  return { frames, mechanics: Array.from(mechanicSet) };
}