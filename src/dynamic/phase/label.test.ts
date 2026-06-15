import { describe, it, expect, vi } from "vitest";
import { labelPhase, labelPhases, createPhaseLabelCache } from "./label.js";
import type { Phase, PhaseModel } from "./discover.js";

function phase(id: string, domains: string[], frameCount = 1): Phase {
  return {
    id,
    signature: { id, domains, hotDomain: domains[0] ?? null },
    frameCount,
    memberSignatureIds: [id],
  };
}

describe("labelPhase", () => {
  it("parses JSON name/description from the LLM", async () => {
    const llm = vi.fn(async () =>
      'sure: {"name":"Combat","description":"Skill and Effect are hot."}',
    );
    const label = await labelPhase(phase("p1", ["Skill", "Effect"]), llm);
    expect(label.name).toBe("Combat");
    expect(label.description).toBe("Skill and Effect are hot.");
    expect(label.phaseId).toBe("p1");
    // cacheKey is versionedKey(phaseId, modelId, prompt version) — a sha256 hex.
    expect(label.cacheKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cache HIT does not call the LLM; MISS calls exactly once", async () => {
    const llm = vi.fn(async () => '{"name":"X","description":"Y"}');
    const cache = createPhaseLabelCache();
    const p = phase("p1", ["Skill"]);

    await labelPhase(p, llm, cache); // miss
    await labelPhase(p, llm, cache); // hit
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("falls back to truncated text when the response has no JSON", async () => {
    const llm = vi.fn(async () => "no json here");
    const label = await labelPhase(phase("p1", ["A"]), llm);
    expect(label.name).toBe("no json here");
  });
});

describe("labelPhases", () => {
  it("labels every phase in the model", async () => {
    const model: PhaseModel = {
      phases: [phase("p1", ["A"]), phase("p2", ["B"])],
      framePhaseIds: ["p1", "p2"],
      signatureOptions: {},
    };
    const llm = vi.fn(async () => '{"name":"N","description":"D"}');
    const labels = await labelPhases(model, llm, createPhaseLabelCache());
    expect(labels.map((l) => l.phaseId)).toEqual(["p1", "p2"]);
    expect(llm).toHaveBeenCalledTimes(2);
  });
});
