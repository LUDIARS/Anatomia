import { describe, it, expect } from 'vitest';
import { encodeEvent, decodeEvent } from './protocol.js';
import { processEvents } from './ringbuffer.js';
import type { TraceEvent } from './protocol.js';

describe('encodeEvent / decodeEvent round-trip', () => {
  it('round-trips frame_begin', () => {
    const ev: TraceEvent = { type: 'frame_begin', frameId: 1, timestampUs: 1000 };
    expect(decodeEvent(encodeEvent(ev))).toEqual(ev);
  });

  it('round-trips frame_end', () => {
    const ev: TraceEvent = { type: 'frame_end', frameId: 1, timestampUs: 2000 };
    expect(decodeEvent(encodeEvent(ev))).toEqual(ev);
  });

  it('round-trips zone_enter', () => {
    const ev: TraceEvent = { type: 'zone_enter', anchorId: 'anchor-A', timestampUs: 100 };
    expect(decodeEvent(encodeEvent(ev))).toEqual(ev);
  });

  it('round-trips zone_exit', () => {
    const ev: TraceEvent = { type: 'zone_exit', anchorId: 'anchor-A', timestampUs: 500 };
    expect(decodeEvent(encodeEvent(ev))).toEqual(ev);
  });
});

describe('processEvents', () => {
  it('computes zone times for a complete frame', () => {
    const events: TraceEvent[] = [
      { type: 'frame_begin', frameId: 1, timestampUs: 0 },
      { type: 'zone_enter', anchorId: 'A', timestampUs: 100 },
      { type: 'zone_enter', anchorId: 'B', timestampUs: 200 },
      { type: 'zone_exit', anchorId: 'B', timestampUs: 300 },
      { type: 'zone_exit', anchorId: 'A', timestampUs: 500 },
      { type: 'frame_end', frameId: 1, timestampUs: 600 },
    ];

    const frames = processEvents(events);
    expect(frames).toHaveLength(1);
    const frame = frames[0]!;
    expect(frame.frameId).toBe(1);
    expect(frame.frameBeginUs).toBe(0);
    expect(frame.frameEndUs).toBe(600);
    // activeZoneSet should contain both A and B (order may vary)
    expect([...frame.activeZoneSet].sort()).toEqual(['A', 'B']);
    // A was entered at 100, exited at 500 => 400us
    expect(frame.zoneTimes['A']).toBe(400);
    // B was entered at 200, exited at 300 => 100us
    expect(frame.zoneTimes['B']).toBe(100);
  });

  it('handles still-open zones at frame_end with partial time', () => {
    const events: TraceEvent[] = [
      { type: 'frame_begin', frameId: 2, timestampUs: 0 },
      { type: 'zone_enter', anchorId: 'X', timestampUs: 50 },
      // No zone_exit for X — frame ends with X still open
      { type: 'frame_end', frameId: 2, timestampUs: 200 },
    ];

    const frames = processEvents(events);
    expect(frames).toHaveLength(1);
    const frame = frames[0]!;
    // X gets partial time: 200 - 50 = 150
    expect(frame.zoneTimes['X']).toBe(150);
    expect(frame.activeZoneSet).toContain('X');
  });

  it('produces no frames when no frame_end', () => {
    const events: TraceEvent[] = [
      { type: 'frame_begin', frameId: 1, timestampUs: 0 },
      { type: 'zone_enter', anchorId: 'A', timestampUs: 10 },
    ];
    const frames = processEvents(events);
    expect(frames).toHaveLength(0);
  });
});
