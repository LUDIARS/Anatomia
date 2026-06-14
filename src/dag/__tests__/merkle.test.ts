import { describe, it, expect } from "vitest";
import { buildFileNode, buildRepoNode } from "../merkle.js";
import type { AnchorId, FunctionNode } from "../../types.js";

function fn(name: string, id: string): FunctionNode {
  return {
    id: id as AnchorId,
    name,
    signature: "sig " + name,
    sourceRange: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 }, filePath: "f" },
    bodyAst: undefined as never,
  };
}

describe("T07 merkle", () => {
  it("file hash is order-independent (sorted child hashes)", () => {
    const a = buildFileNode("/f.cpp", [fn("a", "1111"), fn("b", "2222")]);
    const b = buildFileNode("/f.cpp", [fn("b", "2222"), fn("a", "1111")]);
    expect(a.hash).toBe(b.hash);
  });

  it("changing one function changes the file hash", () => {
    const a = buildFileNode("/f.cpp", [fn("a", "1111"), fn("b", "2222")]);
    const b = buildFileNode("/f.cpp", [fn("a", "1111"), fn("b", "3333")]);
    expect(a.hash).not.toBe(b.hash);
  });

  it("identical function sets -> identical file hash", () => {
    const a = buildFileNode("/f.cpp", [fn("a", "1111"), fn("b", "2222")]);
    const b = buildFileNode("/g.cpp", [fn("a", "1111"), fn("b", "2222")]);
    expect(a.hash).toBe(b.hash);
  });

  it("throws if a function lacks an AnchorId", () => {
    const bad = { ...fn("a", "1111"), id: null } as FunctionNode;
    expect(() => buildFileNode("/f.cpp", [bad])).toThrow(/AnchorId/);
  });

  it("repo hash changes when a contained file changes", () => {
    const f1 = buildFileNode("/a.cpp", [fn("a", "1111")]);
    const f2 = buildFileNode("/b.cpp", [fn("b", "2222")]);
    const f2b = buildFileNode("/b.cpp", [fn("b", "9999")]);
    const repo = buildRepoNode([f1, f2]);
    const repo2 = buildRepoNode([f1, f2b]);
    expect(repo.hash).not.toBe(repo2.hash);
    expect(buildRepoNode([f1, f2]).hash).toBe(repo.hash);
  });
});
