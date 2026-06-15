import { describe, it, expect } from "vitest";
import { frameSignature, domainSetJaccard } from "./signature.js";
import type { StitchedFrame } from "../stitch.js";

function frame(
  activeDomains: string[],
  domainTimes: Record<string, number>,
  hotDomain: string | null,
): StitchedFrame {
  return {
    frameId: 1,
    frameBeginUs: 0,
    frameEndUs: 100,
    activeDomains,
    domainTimes,
    hotZone: hotDomain === null ? null : { anchorId: "a", domain: hotDomain, accumulatedUs: 1 },
  };
}

describe("frameSignature", () => {
  it("is deterministic and order-independent over the domain set", () => {
    const a = frameSignature(frame(["Skill", "Effect"], { Skill: 5, Effect: 3 }, "Skill"));
    const b = frameSignature(frame(["Effect", "Skill"], { Effect: 3, Skill: 5 }, "Skill"));
    expect(a.id).toBe(b.id);
    expect(a.domains).toEqual(["Effect", "Skill"]); // sorted
  });

  it("different active-domain sets => different ids", () => {
    const a = frameSignature(frame(["Skill"], { Skill: 5 }, "Skill"));
    const b = frameSignature(frame(["Skill", "Effect"], { Skill: 5, Effect: 1 }, "Skill"));
    expect(a.id).not.toBe(b.id);
  });

  it("hot domain participates in the id by default but can be ignored", () => {
    const hotA = frameSignature(frame(["Skill", "Effect"], { Skill: 5, Effect: 3 }, "Skill"));
    const hotB = frameSignature(frame(["Skill", "Effect"], { Skill: 3, Effect: 5 }, "Effect"));
    expect(hotA.id).not.toBe(hotB.id);

    const noHotA = frameSignature(
      frame(["Skill", "Effect"], { Skill: 5, Effect: 3 }, "Skill"),
      { useHotDomain: false },
    );
    const noHotB = frameSignature(
      frame(["Skill", "Effect"], { Skill: 3, Effect: 5 }, "Effect"),
      { useHotDomain: false },
    );
    expect(noHotA.id).toBe(noHotB.id);
    expect(noHotA.hotDomain).toBeNull();
  });

  it("topK keeps only the hottest k domains by time", () => {
    const sig = frameSignature(
      frame(["A", "B", "C"], { A: 1, B: 10, C: 5 }, "B"),
      { topK: 2, useHotDomain: false },
    );
    expect(sig.domains).toEqual(["B", "C"]); // top-2 by time, then sorted
  });

  it("empty hot domain ('') normalises to null", () => {
    const sig = frameSignature(frame(["A"], { A: 1 }, ""));
    expect(sig.hotDomain).toBeNull();
  });
});

describe("domainSetJaccard", () => {
  it("two empty sets are identical", () => {
    expect(domainSetJaccard([], [])).toBe(1);
  });
  it("computes intersection over union", () => {
    expect(domainSetJaccard(["A", "B"], ["B", "C"])).toBeCloseTo(1 / 3);
    expect(domainSetJaccard(["A", "B"], ["A", "B"])).toBe(1);
    expect(domainSetJaccard(["A"], ["B"])).toBe(0);
  });
});
