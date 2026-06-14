/**
 * T20 — Tests for mechanic-card generation + content-keyed caching (card.ts).
 *
 * Uses a MOCK LLMClient that counts calls to prove the cache:
 *   - same content (same implementors) => llm called exactly ONCE across two
 *     generateCard calls.
 *   - different content => llm called again.
 */

import { describe, it, expect } from "vitest";
import {
  generateCard,
  createCardCache,
  merkleHash,
  type LLMClient,
} from "./card.js";
import type { DetectionResult } from "./detect.js";
import type { AnchorId, CodeNode } from "../types.js";
import type { CodeGraphQuery } from "../graph/query.js";

/** Minimal stub graph: getNode returns a synthetic node per id. */
function stubGraph(): CodeGraphQuery {
  const make = (id: AnchorId): CodeNode => ({
    id,
    name: "fn_" + id,
    kind: "function",
    sourceRange: { start: { line: 1, column: 0 }, end: { line: 2, column: 0 }, filePath: "/x.cpp" },
  });
  return {
    getNode: async (id) => make(id),
    allNodes: async () => [],
    neighbors: async () => [],
    predecessors: async () => [],
    edgesFrom: async () => [],
    edgesTo: async () => [],
    edgesMatching: async () => [],
    fanCounts: async () => ({ fanIn: 0, fanOut: 0 }),
    reachable: async () => [],
    isReachable: async () => false,
  };
}

function mockLLM(): { llm: LLMClient; calls: () => number } {
  let count = 0;
  const llm: LLMClient = async (_prompt: string) => {
    count++;
    return JSON.stringify({
      summary: "a summary",
      rules: ["rule A", "rule B"],
      specRefs: ["DESIGN §4.4"],
      complexity: "medium",
    });
  };
  return { llm, calls: () => count };
}

function result(impls: string[]): DetectionResult {
  return {
    mechanic: "m",
    implementors: impls as AnchorId[],
    violations: [],
    conforms: true,
  };
}

describe("T20 generateCard — content-keyed caching", () => {
  it("calls the LLM exactly once for identical content across two calls", async () => {
    const cache = createCardCache();
    const { llm, calls } = mockLLM();
    const graph = stubGraph();
    const r = result(["aaaa", "bbbb"]);

    const card1 = await generateCard("m", r, graph, llm, cache);
    const card2 = await generateCard("m", r, graph, llm, cache);

    expect(calls()).toBe(1); // second call is a cache HIT
    expect(card1.cacheKey).toBe(card2.cacheKey);
    expect(card2).toEqual(card1);
    expect(card1.summary).toBe("a summary");
    expect(card1.complexity).toBe("medium");
  });

  it("calls the LLM again for different content", async () => {
    const cache = createCardCache();
    const { llm, calls } = mockLLM();
    const graph = stubGraph();

    await generateCard("m", result(["aaaa", "bbbb"]), graph, llm, cache);
    await generateCard("m", result(["cccc", "dddd"]), graph, llm, cache);

    expect(calls()).toBe(2); // different cache key => miss => second call
  });

  it("cacheKey is order-independent over implementors", () => {
    expect(merkleHash(["a", "b"] as AnchorId[])).toBe(
      merkleHash(["b", "a"] as AnchorId[]),
    );
  });

  it("without a cache, every call hits the LLM", async () => {
    const { llm, calls } = mockLLM();
    const graph = stubGraph();
    const r = result(["aaaa"]);
    await generateCard("m", r, graph, llm);
    await generateCard("m", r, graph, llm);
    expect(calls()).toBe(2);
  });

  it("keyAnchors are the sorted implementors", async () => {
    const { llm } = mockLLM();
    const graph = stubGraph();
    const card = await generateCard("m", result(["bbbb", "aaaa"]), graph, llm);
    expect(card.keyAnchors).toEqual(["aaaa", "bbbb"]);
  });
});
