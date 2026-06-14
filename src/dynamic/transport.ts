/**
 * T37 — Trace receiver consuming async iterable of TraceEvents, yielding DecodedFrames.
 */
import type { TraceEvent, DecodedFrame } from './protocol.js';
import { processEvents, createRingBufferState } from './ringbuffer.js';

export interface TraceReceiverOptions {
  maxRetries?: number;    // default: 3
  retryDelayMs?: number;  // default: 1000
}

export async function* createTraceReceiver(
  source: AsyncIterable<TraceEvent>,
  options?: TraceReceiverOptions,
): AsyncGenerator<DecodedFrame> {
  const retryDelayMs = options?.retryDelayMs ?? 1000;
  const state = createRingBufferState();

  try {
    for await (const event of source) {
      const frames = processEvents([event], state);
      for (const frame of frames) {
        yield frame;
      }
    }
  } catch {
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    // Source is exhausted/errored — stop (can't retry single source)
  }
}

export async function* createTraceReceiverWithRetry(
  sourceFactory: () => AsyncIterable<TraceEvent>,
  options?: TraceReceiverOptions,
): AsyncGenerator<DecodedFrame> {
  const maxRetries = options?.maxRetries ?? 3;
  const retryDelayMs = options?.retryDelayMs ?? 1000;

  let attempt = 0;
  while (attempt <= maxRetries) {
    const state = createRingBufferState();
    try {
      const source = sourceFactory();
      for await (const event of source) {
        const frames = processEvents([event], state);
        for (const frame of frames) {
          yield frame;
        }
      }
      // Source completed normally — done
      return;
    } catch {
      attempt++;
      if (attempt > maxRetries) break;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}
