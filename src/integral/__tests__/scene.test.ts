/**
 * Tests for the scene layer's trace wiring (scenesFromTrace / sceneModelFromTrace).
 *
 * A scene = a distinct 局面 (phase signature) of a recorded/live trace. We feed a
 * RecordedTraceSource synthetic stitched frames and assert distinct active-domain
 * sets collapse to distinct scenes, identical sets fold to one, and an empty
 * trace degrades to an empty model.
 */

import { describe, it, expect } from "vitest";
import { RecordedTraceSource } from "../../dynamic/viz/trace-source.js";
import type { FrameWithZones } from "../../dynamic/viz/trace-source.js";
import type { StitchedFrame } from "../../dynamic/stitch.js";
import { scenesFromTrace, sceneModelFromTrace } from "../scene.js";

function frame(id: number, domains: string[], hot: string | null): FrameWithZones {
  const stitched: StitchedFrame = {
    frameId: id,
    frameBeginUs: id * 1000,
    frameEndUs: id * 1000 + 500,
    activeDomains: domains,
    hotZone: hot ? { anchorId: `a${id}`, domain: hot, accumulatedUs: 100 } : null,
    domainTimes: Object.fromEntries(domains.map((d) => [d, 100])),
  };
  return { stitched, activeZoneSet: domains.map((d) => `anchor:${d}`) };
}

describe("scenesFromTrace", () => {
  it("derives one scene per distinct active-domain set", () => {
    const trace = new RecordedTraceSource([
      frame(1, ["combat", "movement"], "combat"),
      frame(2, ["combat", "movement"], "combat"), // same phase → folds with frame 1
      frame(3, ["menu"], "menu"),
    ]);
    const scenes = scenesFromTrace(trace);
    expect(scenes.length).toBe(2);
    const domainSets = scenes.map((s) => s.domains.join(","));
    expect(domainSets).toContain("combat,movement");
    expect(domainSets).toContain("menu");
  });

  it("an empty trace yields no scenes (graceful)", () => {
    expect(scenesFromTrace(new RecordedTraceSource([]))).toEqual([]);
  });

  it("sceneModelFromTrace exposes domain → scene lookup", () => {
    const trace = new RecordedTraceSource([frame(1, ["combat", "movement"], "combat")]);
    const model = sceneModelFromTrace(trace);
    expect(model.scenesForDomain("combat").length).toBe(1);
    expect(model.scenesForDomain("movement").length).toBe(1);
    expect(model.scenesForDomain("nope").length).toBe(0);
  });
});
