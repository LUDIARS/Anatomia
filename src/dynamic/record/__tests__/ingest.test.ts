/**
 * Tests for recorded-trace ingest: JSONL events → decode → stitch → scenes,
 * using LLM-free cards derived from the static detection result.
 */

import { describe, it, expect } from "vitest";
import type { AnchorId } from "../../../types.js";
import type { DetectionResult } from "../../../domains/detect.js";
import {
  parseTraceJsonl,
  cardsFromDomains,
  decodeStitchedFrames,
  sceneModelFromTraceFile,
} from "../ingest.js";

const domains: DetectionResult[] = [
  { domain: "combat", implementors: ["anchorA" as AnchorId, "anchorB" as AnchorId], violations: [], conforms: true },
  { domain: "menu", implementors: ["anchorM" as AnchorId], violations: [], conforms: true },
];

// frame 1: combat zone; frame 2: menu zone.
const JSONL = [
  '{"type":"frame_begin","frameId":1,"timestampUs":0}',
  '{"type":"zone_enter","anchorId":"anchorA","timestampUs":10}',
  '{"type":"zone_exit","anchorId":"anchorA","timestampUs":110}',
  '{"type":"frame_end","frameId":1,"timestampUs":120}',
  "", // blank line tolerated
  '{"type":"frame_begin","frameId":2,"timestampUs":200}',
  '{"type":"zone_enter","anchorId":"anchorM","timestampUs":210}',
  '{"type":"zone_exit","anchorId":"anchorM","timestampUs":260}',
  '{"type":"frame_end","frameId":2,"timestampUs":270}',
  '{"type":"garbage', // truncated final line tolerated
].join("\n");

describe("parseTraceJsonl", () => {
  it("parses valid events and skips blank/garbage lines", () => {
    const events = parseTraceJsonl(JSONL);
    expect(events.length).toBe(8); // 2 frames × (begin + enter + exit + end)
    expect(events[0]!.type).toBe("frame_begin");
  });
});

describe("cardsFromDomains", () => {
  it("builds LLM-free cards keyed by implementor anchors", () => {
    const cards = cardsFromDomains(domains);
    expect(cards.map((c) => c.domain).sort()).toEqual(["combat", "menu"]);
    expect(cards.find((c) => c.domain === "combat")!.keyAnchors).toContain("anchorA");
  });
});

describe("decodeStitchedFrames", () => {
  it("stitches each frame onto its active domain", () => {
    const frames = decodeStitchedFrames(parseTraceJsonl(JSONL), cardsFromDomains(domains));
    expect(frames.length).toBe(2);
    expect(frames[0]!.stitched.activeDomains).toEqual(["combat"]);
    expect(frames[1]!.stitched.activeDomains).toEqual(["menu"]);
  });
});

describe("sceneModelFromTraceFile", () => {
  it("derives a scene per distinct active-domain set from a recorded trace", () => {
    const model = sceneModelFromTraceFile(JSONL, domains);
    expect(model.scenes().length).toBe(2);
    expect(model.scenesForDomain("combat").length).toBe(1);
    expect(model.scenesForDomain("menu").length).toBe(1);
  });

  it("empty trace → empty scene model", () => {
    const model = sceneModelFromTraceFile("", domains);
    expect(model.scenes().length).toBe(0);
  });
});
