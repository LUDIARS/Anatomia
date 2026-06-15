import { describe, it, expect } from "vitest";
import { buildClassifier } from "./classify.js";
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

describe("buildClassifier", () => {
  it("resolves a known frame to its learned phase", () => {
    const model = discoverPhases([frame(["Skill"], "Skill"), frame(["Skill", "Effect"], "Effect")]);
    const clf = buildClassifier(model);
    const skillPhase = model.framePhaseIds[0];
    expect(clf.classifyFrame(frame(["Skill"], "Skill"))).toBe(skillPhase);
  });

  it("returns null for an unknown signature with no fallback", () => {
    const model = discoverPhases([frame(["Skill"], "Skill")]);
    const clf = buildClassifier(model);
    expect(clf.classifyFrame(frame(["Brain", "Control"], "Brain"))).toBeNull();
  });

  it("nearestThreshold falls back to the closest phase by domain Jaccard", () => {
    const model = discoverPhases(
      [frame(["A", "B", "C"], null), frame(["X", "Y"], null)],
      { signature: { useHotDomain: false } },
    );
    const clf = buildClassifier(model, { nearestThreshold: 0.5 });
    // {A,B} is 2/3 close to {A,B,C}, 0 to {X,Y} => maps to the {A,B,C} phase.
    const abc = model.framePhaseIds[0];
    expect(clf.classifyFrame(frame(["A", "B"], null))).toBe(abc);
  });

  it("classifyWindow majority-votes and debounces a single-frame blip", () => {
    const model = discoverPhases([
      frame(["Skill"], "Skill"),
      frame(["Skill", "Effect"], "Effect"),
    ]);
    const clf = buildClassifier(model);
    const skillPhase = model.framePhaseIds[0];
    const window = [
      frame(["Skill"], "Skill"),
      frame(["Skill", "Effect"], "Effect"), // single blip
      frame(["Skill"], "Skill"),
    ];
    expect(clf.classifyWindow(window)).toBe(skillPhase);
  });

  it("classifyWindow returns null when nothing is recognised", () => {
    const model = discoverPhases([frame(["Skill"], "Skill")]);
    const clf = buildClassifier(model);
    expect(clf.classifyWindow([frame(["Z"], "Z"), frame(["Q"], "Q")])).toBeNull();
  });
});
