/**
 * augmentGraph — overlay a diff's new functions + outgoing edges onto a copy of
 * an existing graph, resolving callees against the combined (base ∪ diff) names.
 * This is what lets verify see a brand-new violating call against existing code.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../dag/parser.js";
import { extractFunctions } from "../../dag/extract.js";
import { normalize } from "../../dag/normalize.js";
import { assignAnchorId } from "../../dag/hash.js";
import { buildFileNode } from "../../dag/merkle.js";
import { buildGraph, extractEdgeInfo, augmentGraph } from "../build.js";
import type { FileNode, AnchorId } from "../../types.js";
import type { FunctionEdgeInfo } from "../build.js";

async function fileOf(src: string, path: string): Promise<{ file: FileNode; edgeInfo: Map<AnchorId, FunctionEdgeInfo> }> {
  const tree = await parse(src, "cpp");
  const fns = extractFunctions(tree, src, path);
  for (const fn of fns) assignAnchorId(fn, normalize(fn.bodyAst));
  const file = buildFileNode(path, fns);
  const edgeInfo = extractEdgeInfo([file]);
  tree.delete();
  return { file, edgeInfo };
}

describe("augmentGraph", () => {
  it("adds diff nodes and resolves a new function's call to an existing function", async () => {
    // Base: a render function lives under render/.
    const base = await fileOf("void draw_sprite() { return; }", "/repo/src/render/r.cpp");
    const g = buildGraph([base.file], base.edgeInfo);

    // Diff: a new data-layer function that calls the existing render function.
    const diff = await fileOf("void touch() { draw_sprite(); }", "/repo/src/data/d.cpp");
    const aug = augmentGraph(g, [diff.file], diff.edgeInfo);

    const touch = diff.file.functions[0]!.id!;
    const drawSprite = base.file.functions[0]!.id!;
    // The new node exists…
    expect(aug.nodes.has(touch)).toBe(true);
    // …and an edge touch -> draw_sprite was synthesised from the diff.
    expect(aug.edges.some((e) => e.from === touch && e.to === drawSprite && e.kind === "calls")).toBe(true);
  });

  it("does not mutate the base graph", async () => {
    const base = await fileOf("void cal() { return; }", "/repo/src/render/r.cpp");
    const g = buildGraph([base.file], base.edgeInfo);
    const beforeNodes = g.nodes.size;
    const beforeEdges = g.edges.length;

    const diff = await fileOf("void up() { cal(); }", "/repo/src/data/d.cpp");
    augmentGraph(g, [diff.file], diff.edgeInfo);

    expect(g.nodes.size).toBe(beforeNodes);
    expect(g.edges.length).toBe(beforeEdges);
  });

  it("resolves a call between two sibling diff functions", async () => {
    const base = await fileOf("void unrelated() { return; }", "/repo/src/util/u.cpp");
    const g = buildGraph([base.file], base.edgeInfo);

    const diff = await fileOf("void b() { return; }\nvoid a() { b(); }", "/repo/src/enemy/e.cpp");
    const aug = augmentGraph(g, [diff.file], diff.edgeInfo);

    const byName = (n: string) => diff.file.functions.find((f) => f.name === n)!.id!;
    expect(aug.edges.some((e) => e.from === byName("a") && e.to === byName("b") && e.kind === "calls")).toBe(true);
  });
});
