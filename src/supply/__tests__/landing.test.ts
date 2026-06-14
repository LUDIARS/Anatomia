/**
 * T27 — Tests for landing.ts.
 * Mechanic detector, layer rules and sibling lookup are mocked inline.
 */

import { describe, it, expect } from "vitest";
import { resolveLanding } from "../landing.js";
import type {
  LandingTask,
  MechanicDetector,
  LayerRules,
  SiblingLookup,
  Sibling,
} from "../landing.js";
import type { AnchorId } from "../../types.js";

function a(id: string): AnchorId {
  return id as unknown as AnchorId;
}

const layerRules: LayerRules = {
  layerFor(mechanic) {
    if (mechanic === "Effect") return "effect";
    if (mechanic === "Skill") return "skill";
    return null; // unknown mechanic => novel layer
  },
};

describe("T27 resolveLanding", () => {
  it("precedent (siblings exist) => deterministic, high confidence, concrete anchor", async () => {
    const detector: MechanicDetector = async () => ["Effect"];
    const siblings: SiblingLookup = async () => [
      { anchor: a("hashB"), name: "PoisonEffect", layer: "effect" },
      { anchor: a("hashA"), name: "BurnEffect", layer: "effect" },
    ];
    const task: LandingTask = { description: "add a freeze effect" };
    const result = await resolveLanding(task, detector, layerRules, siblings);
    expect(result).toHaveLength(1);
    expect(result[0]!.mechanic).toBe("Effect");
    expect(result[0]!.confidence).toBeGreaterThanOrEqual(0.9);
    // Deterministic pick: lowest anchor wins (hashA < hashB).
    expect(result[0]!.anchor).toBe(a("hashA"));
    expect(result[0]!.proposal).toBeUndefined();
  });

  it("novel mechanic (no siblings, layer known) => layer + proposal, lower confidence", async () => {
    const detector: MechanicDetector = async () => ["Effect"];
    const siblings: SiblingLookup = async () => []; // none yet
    const result = await resolveLanding(
      { description: "first effect ever" },
      detector,
      layerRules,
      siblings,
    );
    expect(result[0]!.anchor).toBeNull();
    expect(result[0]!.layer).toBe("effect");
    expect(result[0]!.confidence).toBeLessThan(0.9);
    expect(result[0]!.proposal).toMatch(/layer "effect"/);
  });

  it("fully novel (no layer, no sibling) => lowest confidence", async () => {
    const detector: MechanicDetector = async () => ["Telepathy"];
    const siblings: SiblingLookup = async () => [];
    const result = await resolveLanding(
      { description: "mind reading" },
      detector,
      layerRules,
      siblings,
    );
    expect(result[0]!.layer).toBeNull();
    expect(result[0]!.anchor).toBeNull();
    expect(result[0]!.confidence).toBeLessThan(0.5);
  });

  it("cross-cutting task => decompose into multiple landings, one per mechanic", async () => {
    // status effect = UI + combat + save
    const detector: MechanicDetector = async () => ["Skill", "Effect"];
    const siblingMap: Record<string, Sibling[]> = {
      Skill: [{ anchor: a("sk1"), name: "DashSkill", layer: "skill" }],
      Effect: [], // no precedent for Effect
    };
    const siblings: SiblingLookup = async (m) => siblingMap[m] ?? [];
    const result = await resolveLanding(
      { description: "status effect across systems" },
      detector,
      layerRules,
      siblings,
    );
    expect(result).toHaveLength(2);
    // Deterministic mechanic order (sorted): Effect, Skill
    expect(result.map((r) => r.mechanic)).toEqual(["Effect", "Skill"]);
    const effect = result.find((r) => r.mechanic === "Effect")!;
    const skill = result.find((r) => r.mechanic === "Skill")!;
    expect(effect.anchor).toBeNull(); // proposal
    expect(skill.anchor).toBe(a("sk1")); // precedent
  });

  it("uses mechanicHints when provided (detector skipped)", async () => {
    let detectorCalled = false;
    const detector: MechanicDetector = async () => {
      detectorCalled = true;
      return ["WRONG"];
    };
    const siblings: SiblingLookup = async () => [];
    const result = await resolveLanding(
      { description: "x", mechanicHints: ["Effect"] },
      detector,
      layerRules,
      siblings,
    );
    expect(detectorCalled).toBe(false);
    expect(result[0]!.mechanic).toBe("Effect");
  });
});
