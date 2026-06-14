import { describe, it, expect } from "vitest";
import { hashFunction, assignAnchorId } from "../hash.js";
import type { FunctionNode } from "../../types.js";

describe("T06 hashFunction", () => {
  it("is deterministic and 16 hex chars (64-bit)", () => {
    const h = hashFunction("(compound_statement)");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(hashFunction("(compound_statement)")).toBe(h);
  });

  it("same normalized form -> same hash", () => {
    expect(hashFunction("X")).toBe(hashFunction("X"));
  });

  it("different normalized form -> different hash", () => {
    expect(hashFunction("X")).not.toBe(hashFunction("Y"));
  });

  it("assignAnchorId fills FunctionNode.id in place", () => {
    const fn = {
      id: null,
      name: "f",
      signature: "void f()",
      sourceRange: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 }, filePath: "x" },
      bodyAst: undefined as never,
    } as unknown as FunctionNode;
    const id = assignAnchorId(fn, "(compound_statement)");
    expect(fn.id).toBe(id);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});
