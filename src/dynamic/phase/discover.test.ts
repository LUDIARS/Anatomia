import { describe, it, expect } from "vitest";
import { discoverPhases } from "./discover.js";
import type { StitchedFrame } from "../stitch.js";

let fid = 0;
function frame(activeDomains: string[], hotDomain: string | null): StitchedFrame {
  const domainTimes: Record<string, number> = {};
  for (const d of activeDomains) domainTimes[d] = 1;
  return {
    frameId: fid++,
    frameBeginUs: 0,
    frameEndUs: 1,
    activeDomains,
    domainTimes,
    hotZone: hotDomain === null ? null : { anchorId: "a", domain: hotDomain, accumulatedUs: 1 },
  };
}

describe("discoverPhases", () => {
  it("groups frames by exact signature and counts frequency", () => {
    const frames = [
      frame(["Skill"], "Skill"),
      frame(["Skill"], "Skill"),
      frame(["Skill", "Effect"], "Effect"),
    ];
    const model = discoverPhases(frames);
    expect(model.phases).toHaveLength(2);
    // Most frequent phase first.
    expect(model.phases[0]!.frameCount).toBe(2);
    expect(model.phases[1]!.frameCount).toBe(1);
    expect(model.framePhaseIds[0]).toBe(model.framePhaseIds[1]); // same phase
    expect(model.framePhaseIds[0]).not.toBe(model.framePhaseIds[2]);
  });

  it("is deterministic: same frames => identical model", () => {
    const make = () => [frame(["A"], "A"), frame(["A", "B"], "B"), frame(["A"], "A")];
    const a = discoverPhases(make());
    const b = discoverPhases(make());
    expect(a.phases.map((p) => p.id)).toEqual(b.phases.map((p) => p.id));
    expect(a.framePhaseIds).toEqual(b.framePhaseIds);
  });

  it("merges near-identical signatures above the Jaccard threshold", () => {
    // {A,B,C} vs {A,B} share 2/3 ≈ 0.67; merge at 0.6 should fold them.
    const frames = [
      frame(["A", "B", "C"], null),
      frame(["A", "B", "C"], null),
      frame(["A", "B"], null),
    ];
    const merged = discoverPhases(frames, { mergeThreshold: 0.6, signature: { useHotDomain: false } });
    expect(merged.phases).toHaveLength(1);
    // Representative = the most frequent signature ({A,B,C}, 2 frames).
    expect(merged.phases[0]!.signature.domains).toEqual(["A", "B", "C"]);
    expect(merged.phases[0]!.frameCount).toBe(3);
    expect(merged.phases[0]!.memberSignatureIds).toHaveLength(2);

    // Without merge, they stay distinct.
    const unmerged = discoverPhases(frames, { signature: { useHotDomain: false } });
    expect(unmerged.phases).toHaveLength(2);
  });

  it("stores the signature options on the model", () => {
    const model = discoverPhases([frame(["A"], "A")], { signature: { topK: 2 } });
    expect(model.signatureOptions).toEqual({ topK: 2 });
  });
});
