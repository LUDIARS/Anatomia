/**
 * T36 (part 1) — Wire protocol / data model.
 */

export type TraceEventType = 'frame_begin' | 'frame_end' | 'zone_enter' | 'zone_exit';

export interface FrameBeginEvent { type: 'frame_begin'; frameId: number; timestampUs: number; }
export interface FrameEndEvent { type: 'frame_end'; frameId: number; timestampUs: number; }
export interface ZoneEnterEvent { type: 'zone_enter'; anchorId: string; timestampUs: number; }
export interface ZoneExitEvent { type: 'zone_exit'; anchorId: string; timestampUs: number; }
export type TraceEvent = FrameBeginEvent | FrameEndEvent | ZoneEnterEvent | ZoneExitEvent;

export interface DecodedFrame {
  frameId: number;
  frameBeginUs: number;
  frameEndUs: number;
  activeZoneSet: string[];
  zoneTimes: Record<string, number>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeEvent(event: TraceEvent): Uint8Array {
  return encoder.encode(JSON.stringify(event));
}

export function decodeEvent(bytes: Uint8Array): TraceEvent {
  return JSON.parse(decoder.decode(bytes)) as TraceEvent;
}
