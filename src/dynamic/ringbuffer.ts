/**
 * T36 (part 2) — Ring buffer decoder.
 */
import type { TraceEvent, DecodedFrame } from './protocol.js';

interface ZoneStackEntry {
  anchorId: string;
  enterTs: number;
}

interface InProgressFrame {
  frameId: number;
  frameBeginUs: number;
  zoneStack: ZoneStackEntry[];
  zoneTimes: Record<string, number>;
  activeZoneSet: Set<string>;
}

export interface RingBufferState {
  /** Currently in-progress frame, or null if no frame has started yet. */
  _currentFrame: InProgressFrame | null;
}

export function createRingBufferState(): RingBufferState {
  return { _currentFrame: null };
}

export function processEvents(events: TraceEvent[], state?: RingBufferState): DecodedFrame[] {
  const s: RingBufferState = state ?? createRingBufferState();
  const completed: DecodedFrame[] = [];

  for (const event of events) {
    switch (event.type) {
      case 'frame_begin': {
        s._currentFrame = {
          frameId: event.frameId,
          frameBeginUs: event.timestampUs,
          zoneStack: [],
          zoneTimes: {},
          activeZoneSet: new Set(),
        };
        break;
      }

      case 'zone_enter': {
        if (s._currentFrame) {
          s._currentFrame.zoneStack.push({ anchorId: event.anchorId, enterTs: event.timestampUs });
          s._currentFrame.activeZoneSet.add(event.anchorId);
        }
        break;
      }

      case 'zone_exit': {
        if (s._currentFrame) {
          // Pop matching entry from stack (innermost match)
          const stack = s._currentFrame.zoneStack;
          let idx = -1;
          for (let i = stack.length - 1; i >= 0; i--) {
            if (stack[i]!.anchorId === event.anchorId) {
              idx = i;
              break;
            }
          }
          if (idx !== -1) {
            const entry = stack.splice(idx, 1)[0]!;
            const delta = event.timestampUs - entry.enterTs;
            s._currentFrame.zoneTimes[event.anchorId] =
              (s._currentFrame.zoneTimes[event.anchorId] ?? 0) + delta;
          }
        }
        break;
      }

      case 'frame_end': {
        if (s._currentFrame) {
          const frame = s._currentFrame;
          // Close any still-open zones with partial time up to frame_end
          for (const entry of frame.zoneStack) {
            const delta = event.timestampUs - entry.enterTs;
            frame.zoneTimes[entry.anchorId] = (frame.zoneTimes[entry.anchorId] ?? 0) + delta;
          }
          frame.zoneStack = [];

          completed.push({
            frameId: frame.frameId,
            frameBeginUs: frame.frameBeginUs,
            frameEndUs: event.timestampUs,
            activeZoneSet: Array.from(frame.activeZoneSet),
            zoneTimes: { ...frame.zoneTimes },
          });
          s._currentFrame = null;
        }
        break;
      }
    }
  }

  // Persist state for streaming (state object is mutated in-place)
  if (state) {
    state._currentFrame = s._currentFrame;
  }

  return completed;
}
