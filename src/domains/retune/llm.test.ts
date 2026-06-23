import { describe, it, expect } from "vitest";
import { stripFence, extractJson, callLlmJson, asArray } from "./llm.js";

describe("retune llm helper", () => {
  it("stripFence unwraps a ```json fence", () => {
    expect(stripFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFence('{"a":1}')).toBe('{"a":1}');
  });

  it("extractJson finds the first balanced object after prose", () => {
    expect(extractJson('Here is the JSON: {"a":{"b":2}} done')).toBe('{"a":{"b":2}}');
  });

  it("extractJson ignores braces inside strings", () => {
    expect(extractJson('{"a":"a } b","c":1}')).toBe('{"a":"a } b","c":1}');
  });

  it("extractJson handles arrays", () => {
    expect(extractJson("prefix [1, 2, [3]] suffix")).toBe("[1, 2, [3]]");
  });

  it("callLlmJson parses a fenced completion", async () => {
    const llm = async () => '```json\n{"domains":[{"name":"x"}]}\n```';
    const out = await callLlmJson<{ domains: { name: string }[] }>(llm, "p");
    expect(out.domains[0]!.name).toBe("x");
  });

  it("callLlmJson throws on non-JSON", async () => {
    const llm = async () => "no json here";
    await expect(callLlmJson(llm, "p")).rejects.toThrow(/non-JSON/);
  });

  it("asArray normalizes bare objects and nullish", () => {
    expect(asArray([1, 2])).toEqual([1, 2]);
    expect(asArray({ a: 1 })).toEqual([{ a: 1 }]);
    expect(asArray(null)).toEqual([]);
  });
});
