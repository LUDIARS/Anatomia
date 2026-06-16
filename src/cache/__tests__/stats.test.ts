/**
 * aggregate() — global / per-namespace / per-session hit rates + token spend.
 */
import { describe, it, expect } from "vitest";
import { aggregate, formatReport } from "../stats.js";
import type { CacheEvent } from "../transcript.js";

function get(session: string, ns: string, hit: boolean): CacheEvent {
  return { kind: "get", ts: 0, session, ns, hit, key: `${session}-${ns}-${hit}` };
}
function llm(session: string, input: number, output: number): CacheEvent {
  return {
    kind: "llm",
    ts: 0,
    session,
    model: "m",
    usage: { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheCreationTokens: 0 },
  };
}

describe("aggregate", () => {
  it("computes global, namespace and session hit rates", () => {
    const events: CacheEvent[] = [
      get("s1", "card", false),
      get("s1", "card", true),
      get("s1", "phase", true),
      get("s2", "card", true),
    ];
    const r = aggregate(events);
    expect(r.global).toEqual({ gets: 4, hits: 3, misses: 1, hitRate: 0.75 });
    expect(r.byNamespace.card).toEqual({ gets: 3, hits: 2, misses: 1, hitRate: 2 / 3 });
    expect(r.byNamespace.phase).toEqual({ gets: 1, hits: 1, misses: 0, hitRate: 1 });
    expect(r.bySession.s1.hitRate).toBeCloseTo(2 / 3);
    expect(r.bySession.s2).toEqual({ gets: 1, hits: 1, misses: 0, hitRate: 1 });
  });

  it("sums LLM tokens and estimates calls/tokens saved", () => {
    const events: CacheEvent[] = [
      get("s", "card", false), // miss -> a call
      get("s", "card", true), // hit -> a saved call
      get("s", "card", true), // hit -> a saved call
      llm("s", 100, 20), // the one real call
    ];
    const r = aggregate(events);
    expect(r.llmCalls).toBe(1);
    expect(r.tokens.inputTokens).toBe(100);
    expect(r.tokens.outputTokens).toBe(20);
    expect(r.estimatedCallsSaved).toBe(2); // 2 hits
    // mean call size = 120; 2 hits saved => ~240 tokens
    expect(r.estimatedTokensSaved).toBe(240);
  });

  it("empty transcript yields zeroed report (no NaN)", () => {
    const r = aggregate([]);
    expect(r.global.hitRate).toBe(0);
    expect(r.estimatedTokensSaved).toBe(0);
    expect(formatReport(r)).toContain("no cache events recorded");
  });

  it("formats a human report with a GLOBAL line", () => {
    const out = formatReport(aggregate([get("s", "card", true), get("s", "card", false)]));
    expect(out).toContain("GLOBAL");
    expect(out).toContain("50.0%");
  });
});
