import { describe, it, expect } from 'vitest';
import { buildTimeline } from './timeline.js';
import type { StitchedFrame } from '../stitch.js';

const makeFrame = (id: number, mechanics: string[], times: Record<string,number>): StitchedFrame => ({
  frameId: id,
  frameBeginUs: id * 16000,
  frameEndUs: id * 16000 + 16000,
  activeMechanics: mechanics,
  hotZone: null,
  mechanicTimes: times,
});

describe('buildTimeline', () => {
  it('returns empty timeline for empty input', () => {
    const result = buildTimeline([]);
    expect(result.frames).toHaveLength(0);
    expect(result.mechanics).toHaveLength(0);
  });

  it('maps stitched frames to ordered bars', () => {
    const frames = [
      makeFrame(1, ['Physics', 'Render'], { Physics: 5000, Render: 8000 }),
      makeFrame(2, ['Input', 'Physics'], { Input: 1000, Physics: 6000 }),
    ];
    const result = buildTimeline(frames);

    expect(result.frames).toHaveLength(2);
    expect(result.frames[0]!.bars).toEqual([
      { mechanic: 'Physics', durationUs: 5000 },
      { mechanic: 'Render', durationUs: 8000 },
    ]);
    expect(result.frames[0]!.totalUs).toBe(16000);
    expect(result.frames[1]!.bars[0]!.mechanic).toBe('Input');
  });

  it('collects unique mechanic names across window', () => {
    const frames = [
      makeFrame(1, ['A', 'B'], { A: 100, B: 200 }),
      makeFrame(2, ['B', 'C'], { B: 150, C: 300 }),
    ];
    const result = buildTimeline(frames);
    expect(result.mechanics.sort()).toEqual(['A', 'B', 'C']);
  });

  it('respects the window parameter (last N frames)', () => {
    const frames = [
      makeFrame(1, ['A'], { A: 100 }),
      makeFrame(2, ['B'], { B: 200 }),
      makeFrame(3, ['C'], { C: 300 }),
    ];
    const result = buildTimeline(frames, 2);
    expect(result.frames).toHaveLength(2);
    expect(result.frames[0]!.frameId).toBe(2);
    expect(result.frames[1]!.frameId).toBe(3);
  });

  it('returns 0 duration bar when mechanic has no time recorded', () => {
    const frames = [makeFrame(1, ['X'], {})];
    const result = buildTimeline(frames);
    expect(result.frames[0]!.bars[0]!.durationUs).toBe(0);
  });
});