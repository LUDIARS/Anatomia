/**
 * T40-T42 -- TraceSource interface: live or recorded stitched-frame supplier.
 * Decouples viz shapers and web endpoints from the live G7 transport.
 */
import type { StitchedFrame } from '../stitch.js';

export interface FrameWithZones {
  stitched: StitchedFrame;
  /** Raw anchor IDs active this frame (from DecodedFrame.activeZoneSet). */
  activeZoneSet: string[];
}

export interface TraceSource {
  /** Latest stitched frame, or undefined if no frames received yet. */
  currentFrame(): StitchedFrame | undefined;

  /** Raw anchor IDs active in the current frame (for buildActiveOverlay). */
  currentActiveZoneSet(): string[];

  /**
   * Window of the last N stitched frames (most-recent last).
   * Returns all available frames if N exceeds buffer size.
   */
  recentFrames(n: number): StitchedFrame[];

  /** Whether a live stream is connected (vs. recorded/mock). */
  readonly isLive: boolean;
}

/** In-memory recorded trace source -- holds a fixed array of frames+zones. */
export class RecordedTraceSource implements TraceSource {
  readonly isLive = false;
  private readonly entries: FrameWithZones[];

  constructor(entries: FrameWithZones[]) {
    this.entries = entries;
  }

  currentFrame(): StitchedFrame | undefined {
    return this.entries.at(-1)?.stitched;
  }

  currentActiveZoneSet(): string[] {
    return this.entries.at(-1)?.activeZoneSet ?? [];
  }

  recentFrames(n: number): StitchedFrame[] {
    const src = n >= this.entries.length ? this.entries : this.entries.slice(-n);
    return src.map((e) => e.stitched);
  }
}

/** Live trace source: pushes FrameWithZones as they arrive from G7. */
export class LiveTraceSource implements TraceSource {
  readonly isLive = true;
  private readonly buffer: FrameWithZones[] = [];
  private readonly capacity: number;

  constructor(capacity = 512) {
    this.capacity = capacity;
  }

  push(entry: FrameWithZones): void {
    this.buffer.push(entry);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
  }

  currentFrame(): StitchedFrame | undefined {
    return this.buffer.at(-1)?.stitched;
  }

  currentActiveZoneSet(): string[] {
    return this.buffer.at(-1)?.activeZoneSet ?? [];
  }

  recentFrames(n: number): StitchedFrame[] {
    const src = n >= this.buffer.length ? this.buffer : this.buffer.slice(-n);
    return src.map((e) => e.stitched);
  }
}