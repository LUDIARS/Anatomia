import { describe, it, expect } from "vitest";
import { reindex, buildFileNodeFromSource } from "../incremental.js";
import type { FileNode } from "../../types.js";

const A_V1 = "int a(int x){ return x + 1; }";
const A_V2 = "int a(int x){ return x + 2; }"; // structural change
const A_FMT = "int a(int x){return x+1;}"; // formatting only
const B = "int b(int y){ return y * 2; }";

describe("T09 reindex", () => {
  it("only re-parses changed files; others are carried over by reference", async () => {
    const fa = await buildFileNodeFromSource("/a.cpp", A_V1, "cpp");
    const fb = await buildFileNodeFromSource("/b.cpp", B, "cpp");
    const dag = new Map<string, FileNode>([
      ["/a.cpp", fa],
      ["/b.cpp", fb],
    ]);

    const next = await reindex(dag, new Map([["/a.cpp", A_V2]]), "cpp");

    // /b.cpp untouched: same object reference (not re-parsed)
    expect(next.get("/b.cpp")).toBe(fb);
    // /a.cpp rebuilt: new node, different hash
    expect(next.get("/a.cpp")).not.toBe(fa);
    expect(next.get("/a.cpp")!.hash).not.toBe(fa.hash);
    // original dag is not mutated
    expect(dag.get("/a.cpp")).toBe(fa);
  });

  it("formatting-only change leaves the file hash unchanged", async () => {
    const fa = await buildFileNodeFromSource("/a.cpp", A_V1, "cpp");
    const dag = new Map<string, FileNode>([["/a.cpp", fa]]);
    const next = await reindex(dag, new Map([["/a.cpp", A_FMT]]), "cpp");
    expect(next.get("/a.cpp")!.hash).toBe(fa.hash);
  });
});
