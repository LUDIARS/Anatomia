import { describe, it, expect } from "vitest";
import { aggregate } from "../stats.js";
import { estimateCost, resolveCostParams } from "../cost-estimate.js";
import type { CacheEvent } from "../transcript.js";

function get(session: string, hit: boolean): CacheEvent {
  return { kind: "get", ts: 0, session, ns: "card", hit, key: `${session}-${hit}` };
}

describe("estimateCost", () => {
  it("uses assumed call size (Opus 4.8 defaults) when no real LLM calls were observed", () => {
    // 1 hit + 3 misses for session A. perCall = 1500/1e6*5 + 400/1e6*25 = 0.0175.
    const report = aggregate([get("A", true), get("A", false), get("A", false), get("A", false)]);
    const cost = estimateCost(report, { session: "A", env: {} });
    expect(cost).not.toBeNull();
    expect(cost!.basis).toBe("assumed");
    expect(cost!.perCallUsd).toBeCloseTo(0.0175, 6);
    expect(cost!.savedUsd).toBeCloseTo(0.0175, 6); // 1 hit
    expect(cost!.spentUsd).toBeCloseTo(0.0525, 6); // 3 misses
    expect(cost!.projectedUsd).toBeCloseTo(0.07, 6); // 4 gets
  });

  it("uses MEASURED mean tokens when real LLM events exist", () => {
    const events: CacheEvent[] = [
      get("A", true),
      get("A", false),
      { kind: "llm", ts: 0, session: "A", model: "claude-opus-4-8", usage: { inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 0, cacheCreationTokens: 0 } },
    ];
    const report = aggregate(events);
    const cost = estimateCost(report, { session: "A", env: {} });
    // perCall from the one real call: 2000/1e6*5 + 1000/1e6*25 = 0.01 + 0.025 = 0.035
    expect(cost!.basis).toBe("measured");
    expect(cost!.perCallUsd).toBeCloseTo(0.035, 6);
  });

  it("returns null for an unknown session slice", () => {
    const report = aggregate([get("A", true)]);
    expect(estimateCost(report, { session: "nope", env: {} })).toBeNull();
  });

  it("honors env price/size overrides", () => {
    const env = { ANATOMIA_COST_INPUT_PER_MTOK: "10", ANATOMIA_COST_OUTPUT_PER_MTOK: "0", ANATOMIA_COST_CALL_INPUT_TOKENS: "1000000", ANATOMIA_COST_CALL_OUTPUT_TOKENS: "0" };
    const { pricing, assumed } = resolveCostParams(env);
    expect(pricing.inputPerMTok).toBe(10);
    expect(assumed.inputTokens).toBe(1_000_000);
    const report = aggregate([get("A", true)]);
    const cost = estimateCost(report, { session: "A", env });
    expect(cost!.perCallUsd).toBeCloseTo(10, 6); // 1M input tok × $10/Mtok
  });
});
