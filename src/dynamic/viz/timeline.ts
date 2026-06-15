/**
 * T40 -- Frame x domain timeline shaper.
 * buildTimeline(stitchedFrames, window) -> TimelineData
 */
import type { StitchedFrame } from '../stitch.js';

export interface TimelineBar {
  domain: string;
  durationUs: number;
}

export interface TimelineFrame {
  frameId: number;
  frameBeginUs: number;
  frameEndUs: number;
  /** Ordered bars (same order as activeDomains in the stitched frame). */
  bars: TimelineBar[];
  /** Total frame wall-clock duration in us. */
  totalUs: number;
}

export interface TimelineData {
  frames: TimelineFrame[];
  /** All unique domain names that appear in this window. */
  domains: string[];
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

  const domainSet = new Set<string>();

  const frames: TimelineFrame[] = source.map((sf) => {
    const bars: TimelineBar[] = sf.activeDomains.map((m) => {
      domainSet.add(m);
      return { domain: m, durationUs: sf.domainTimes[m] ?? 0 };
    });
    return {
      frameId: sf.frameId,
      frameBeginUs: sf.frameBeginUs,
      frameEndUs: sf.frameEndUs,
      bars,
      totalUs: sf.frameEndUs - sf.frameBeginUs,
    };
  });

  return { frames, domains: Array.from(domainSet) };
}