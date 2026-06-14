import { describe, it, expect } from "vitest";
import { diffFiles } from "../diff.js";
import { buildFileNode } from "../merkle.js";
import type { AnchorId, FunctionNode } from "../../types.js";

function fn(name: string, id: string, sig = "void " + name + "()"): FunctionNode {
  return {
    id: id as AnchorId,
    name,
    signature: sig,
    sourceRange: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 }, filePath: "f" },
    bodyAst: undefined as never,
  };
}

describe("T08 diffFiles", () => {
  it("classifies unchanged / changed / added / removed", () => {
    const before = buildFileNode("/f.cpp", [
      fn("keep", "1111"),
      fn("edit", "2222"),
      fn("gone", "3333"),
    ]);
    const after = buildFileNode("/f.cpp", [
      fn("keep", "1111"),
      fn("edit", "2299"),
      fn("new", "4444"),
    ]);
    const d = diffFiles(before, after);
    expect(d.unchanged.map((f) => f.name)).toEqual(["keep"]);
    expect(d.changed.map(([b, a]) => [b.name, a.id, b.id])).toEqual([["edit", "2299", "2222"]]);
    expect(d.added.map((f) => f.name)).toEqual(["new"]);
    expect(d.removed.map((f) => f.name)).toEqual(["gone"]);
  });

  it("treats overloads (same name, different signature) separately", () => {
    const before = buildFileNode("/f.cpp", [fn("f", "1111", "int f(int)")]);
    const after = buildFileNode("/f.cpp", [
      fn("f", "1111", "int f(int)"),
      fn("f", "5555", "int f(int,int)"),
    ]);
    const d = diffFiles(before, after);
    expect(d.unchanged.length).toBe(1);
    expect(d.added.length).toBe(1);
  });
});
