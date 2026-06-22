/**
 * src/dynamic/record/ingest.ts — Ingest a RECORDED trace into scenes.
 *
 * Closes the recording loop: a measurement build of a game emits TraceEvents
 * (frame_begin/zone_enter/zone_exit/frame_end, each zone carrying the AnchorId
 * baked in at injection time — see dynamic/inject-cpp.ts) to a JSONL file. This
 * module reads that file back and turns it into a SceneModel:
 *
 *   JSONL → TraceEvent[] → processEvents → DecodedFrame[] → stitchFrame → scenes
 *
 * stitch needs DomainCards only to map an anchor → its domain; we build those
 * straight from the static detection result (anchor ∈ domain.implementors), so
 * the ingest is **LLM-free and deterministic** (the LLM-distilled cards are an
 * orthogonal, optional enrichment). An empty/absent trace yields an empty scene
 * model — integral search then stays on structure + module + domain.
 *
 * SRP: recorded-trace → scenes only. Decoding is ringbuffer.ts, stitching is
 * stitch.ts, scene shaping is integral/scene.ts.
 */

import type { TraceEvent } from "../protocol.js";
import { processEvents } from "../ringbuffer.js";
import { stitchFrame } from "../stitch.js";
import type { DomainCard } from "../../domains/card.js";
import type { DetectionResult } from "../../domains/detect.js";
import { RecordedTraceSource, type FrameWithZones } from "../viz/trace-source.js";
import { sceneModelFromTrace, type SceneModel } from "../../integral/scene.js";

const EVENT_TYPES = new Set(["frame_begin", "frame_end", "zone_enter", "zone_exit"]);

/** Parse a JSONL trace file body into TraceEvents (blank lines + bad lines skipped). */
export function parseTraceJsonl(text: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // tolerate a truncated final line / log noise
    }
    if (obj && typeof obj === "object" && EVENT_TYPES.has((obj as { type?: string }).type ?? "")) {
      events.push(obj as TraceEvent);
    }
  }
  return events;
}

/**
 * Minimal DomainCards from the static detection result: each domain's implementor
 * anchors become the card's keyAnchors, which is all stitchFrame reads to fold a
 * zone anchor onto its domain. No LLM.
 */
export function cardsFromDomains(domains: DetectionResult[]): DomainCard[] {
  return domains
    .filter((d) => d.implementors.length > 0)
    .map((d) => ({
      domain: d.domain,
      summary: "",
      rules: [],
      keyAnchors: [...d.implementors],
      specRefs: [],
      complexity: "medium" as const,
      cacheKey: `detect:${d.domain}`,
    }));
}

/** Decode + stitch recorded events into frames-with-zones (for a TraceSource). */
export function decodeStitchedFrames(events: TraceEvent[], cards: DomainCard[]): FrameWithZones[] {
  const frames = processEvents(events);
  return frames.map((f) => ({
    stitched: stitchFrame(f, cards),
    activeZoneSet: f.activeZoneSet,
  }));
}

/** Build a RecordedTraceSource from recorded events + detection-derived cards. */
export function traceSourceFromEvents(events: TraceEvent[], cards: DomainCard[]): RecordedTraceSource {
  return new RecordedTraceSource(decodeStitchedFrames(events, cards));
}

/** End-to-end: recorded JSONL + domains → a SceneModel for integral search. */
export function sceneModelFromTraceFile(jsonl: string, domains: DetectionResult[]): SceneModel {
  const events = parseTraceJsonl(jsonl);
  const cards = cardsFromDomains(domains);
  return sceneModelFromTrace(traceSourceFromEvents(events, cards));
}
