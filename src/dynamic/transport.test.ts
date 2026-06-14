import { describe, it, expect } from 'vitest';
import type { TraceEvent } from './protocol.js';
import { createTraceReceiver, createTraceReceiverWithRetry } from './transport.js';

async function* makeSource(events: TraceEvent[]): AsyncGenerator<TraceEvent> {
  for (const ev of events) {
    yield ev;
  }
}

async function collectFrames<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const frames: T[] = [];
  for await (const f of gen) {
    frames.push(f);
  }
  return frames;
}

const fullFrameEvents: TraceEvent[] = [
  { type: 'frame_begin', frameId: 1, timestampUs: 0 },
  { type: 'zone_enter', anchorId: 'A', timestampUs: 100 },
  { type: 'zone_exit', anchorId: 'A', timestampUs: 300 },
  { type: 'frame_end', frameId: 1, timestampUs: 400 },
];

describe('createTraceReceiver', () => {
  it('yields DecodedFrame from a complete frame event sequence', async () => {
    const source = makeSource(fullFrameEvents);
    const frames = await collectFrames(createTraceReceiver(source));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.frameId).toBe(1);
    expect(frames[0]!.zoneTimes['A']).toBe(200);
    expect(frames[0]!.activeZoneSet).toContain('A');
  });

  it('yields multiple frames from multiple frame sequences', async () => {
    const events: TraceEvent[] = [
      { type: 'frame_begin', frameId: 1, timestampUs: 0 },
      { type: 'frame_end', frameId: 1, timestampUs: 100 },
      { type: 'frame_begin', frameId: 2, timestampUs: 200 },
      { type: 'frame_end', frameId: 2, timestampUs: 300 },
    ];
    const source = makeSource(events);
    const frames = await collectFrames(createTraceReceiver(source));
    expect(frames).toHaveLength(2);
    expect(frames[0]!.frameId).toBe(1);
    expect(frames[1]!.frameId).toBe(2);
  });

  it('handles an error from the source gracefully (no throw)', async () => {
    async function* errorSource(): AsyncGenerator<TraceEvent> {
      yield { type: 'frame_begin', frameId: 1, timestampUs: 0 };
      throw new Error('connection lost');
    }
    // Should not throw
    const frames = await collectFrames(createTraceReceiver(errorSource(), { retryDelayMs: 0 }));
    // No complete frame was produced before the error
    expect(frames).toHaveLength(0);
  });
});

describe('createTraceReceiverWithRetry', () => {
  it('retries on factory error and yields frame on second attempt', async () => {
    let calls = 0;
    function factory(): AsyncIterable<TraceEvent> {
      calls++;
      if (calls === 1) {
        // First call throws synchronously when iterated
        return {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<TraceEvent>> {
                return Promise.reject(new Error('transient error'));
              },
            };
          },
        };
      }
      // Second call succeeds
      return makeSource(fullFrameEvents);
    }

    const gen = createTraceReceiverWithRetry(factory, { maxRetries: 3, retryDelayMs: 0 });
    const frames = await collectFrames(gen);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.frameId).toBe(1);
    expect(calls).toBeGreaterThan(1);
  });

  it('gives up after maxRetries exhausted', async () => {
    function factory(): AsyncIterable<TraceEvent> {
      return {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<TraceEvent>> {
              return Promise.reject(new Error('always fails'));
            },
          };
        },
      };
    }

    const gen = createTraceReceiverWithRetry(factory, { maxRetries: 2, retryDelayMs: 0 });
    const frames = await collectFrames(gen);
    // No frames — all attempts failed
    expect(frames).toHaveLength(0);
  });
});
