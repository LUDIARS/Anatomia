/**
 * src/web-cache/search.test.ts — prefilter (pure) + searchCorpus (fake LLM).
 */

import { describe, it, expect } from "vitest";
import { prefilter, searchCorpus } from "./search.js";
import type { SearchCorpus, SearchEntry } from "./types.js";

const ENTRIES: SearchEntry[] = [
  { kind: "function", ref: "f1", title: "spawnEnemy", text: "void spawnEnemy(Wave w)", module: "wave" },
  { kind: "function", ref: "f2", title: "renderHud", text: "draw the hud", module: "ui" },
  { kind: "domain", ref: "combat", title: "combat", text: "10 functions" },
  // title has no "enemy"; body does → a body-only hit (weaker than f1's title hit).
  { kind: "spec", ref: "s1", title: "Wave timing", text: "each enemy spawns per wave" },
];

describe("prefilter", () => {
  it("ranks title hits above body hits and respects kind filter", () => {
    const hits = prefilter(ENTRIES, ["enemy"], []);
    // f1 (title 'spawnEnemy' contains 'enemy') outranks s1 (body only).
    expect(hits[0]!.ref).toBe("f1");
    expect(hits.map((e) => e.ref)).toContain("s1");

    const onlyFns = prefilter(ENTRIES, ["enemy"], ["function"]);
    expect(onlyFns.every((e) => e.kind === "function")).toBe(true);
  });

  it("returns nothing for empty keywords", () => {
    expect(prefilter(ENTRIES, [], [])).toEqual([]);
  });
});

describe("searchCorpus", () => {
  const corpus: SearchCorpus = { entries: ENTRIES };

  it("parses with the LLM, prefilters, and reranks", async () => {
    const calls: string[] = [];
    const llm = async (prompt: string): Promise<string> => {
      calls.push(prompt);
      if (prompt.startsWith("You convert")) {
        return JSON.stringify({ keywords: ["enemy", "spawn"], kinds: [], intent: "find spawning" });
      }
      // rerank call
      return JSON.stringify([{ ref: "f1", reason: "spawns enemies" }, { ref: "s1", reason: "spec" }]);
    };
    const out = await searchCorpus(corpus, "where do enemies spawn", llm);
    expect(calls.length).toBe(2);
    expect(out.intent).toBe("find spawning");
    expect(out.results.map((r) => r.ref)).toEqual(["f1", "s1"]);
    expect(out.results[0]!.reason).toBe("spawns enemies");
  });

  it("falls back to keyword order when the rerank output is unparseable", async () => {
    const llm = async (prompt: string): Promise<string> => {
      if (prompt.startsWith("You convert")) {
        return JSON.stringify({ keywords: ["enemy"], kinds: [], intent: "" });
      }
      return "not json at all";
    };
    const out = await searchCorpus(corpus, "enemy", llm);
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.results[0]!.ref).toBe("f1");
    expect(out.results[0]!.reason).toBe("keyword match");
  });

  it("returns empty results when nothing matches", async () => {
    const llm = async (prompt: string): Promise<string> => {
      if (prompt.startsWith("You convert")) {
        return JSON.stringify({ keywords: ["zzzznomatch"], kinds: [], intent: "" });
      }
      return "[]";
    };
    const out = await searchCorpus(corpus, "zzzznomatch", llm);
    expect(out.results).toEqual([]);
  });
});
