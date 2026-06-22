/**
 * Tests for the 機能(module) layer: partition + cohesion + misfit + modularity.
 *
 * Builds a real two-directory graph (parse → extract → buildGraph) so the module
 * grouping (by source directory) and the structural-tie edges are real, then
 * asserts the cohesion/coupling/misfit/modularity evaluation.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { parse } from "../../dag/parser.js";
import { extractFunctions } from "../../dag/extract.js";
import { normalize } from "../../dag/normalize.js";
import { assignAnchorId } from "../../dag/hash.js";
import { buildFileNode } from "../../dag/merkle.js";
import { buildGraph, extractEdgeInfo } from "../../graph/build.js";
import { InMemoryCodeGraph } from "../../graph/in-memory.js";
import type { FileNode, FunctionNode } from "../../types.js";
import { buildModules, moduleIndex } from "../build.js";
import { evaluateModulesFromGraph } from "../evaluate.js";

// /a/x.cpp internal call (a_main→a_helper) + stray→/b (external);
// /b/y.cpp two leaves.
const A_SRC = `
int a_helper() { return 1; }
int a_main() { return a_helper(); }
int b1();
int b2();
int stray() { return b1() + b2(); }
`;
const B_SRC = `
int b1() { return 1; }
int b2() { return 2; }
`;

async function makeFile(src: string, path: string): Promise<FileNode> {
  const tree = await parse(src, "cpp");
  const fns = extractFunctions(tree, src, path);
  for (const fn of fns) assignAnchorId(fn, normalize(fn.bodyAst));
  const file = buildFileNode(path, fns);
  return file;
}

let graph: InMemoryCodeGraph;
let functions: FunctionNode[];

beforeAll(async () => {
  const a = await makeFile(A_SRC, "/proj/a/x.cpp");
  const b = await makeFile(B_SRC, "/proj/b/y.cpp");
  const edgeInfo = extractEdgeInfo([a, b]);
  graph = new InMemoryCodeGraph(buildGraph([a, b], edgeInfo));
  functions = [...a.functions, ...b.functions];
});

describe("buildModules — directory partition", () => {
  it("groups functions by source directory", () => {
    const mods = buildModules(functions, "dir");
    const ids = mods.map((m) => m.id);
    expect(ids).toContain("/proj/a");
    expect(ids).toContain("/proj/b");
    const a = mods.find((m) => m.id === "/proj/a")!;
    expect(a.anchors.length).toBe(3); // a_helper, a_main, stray
  });

  it("every anchored function lands in exactly one module", () => {
    const mods = buildModules(functions, "dir");
    const index = moduleIndex(mods);
    for (const fn of functions) {
      if (fn.id) expect(index.has(fn.id)).toBe(true);
    }
  });
});

describe("evaluateModulesFromGraph — cohesion / misfit / modularity", () => {
  it("scores /proj/a cohesion below 1 (it leaks to /proj/b)", async () => {
    const { evaluation } = await evaluateModulesFromGraph(graph, functions, "dir");
    const a = evaluation.cohesion.find((c) => c.moduleId === "/proj/a")!;
    expect(a.internalEdges).toBeGreaterThanOrEqual(1); // a_main→a_helper
    expect(a.outgoingExternal).toBeGreaterThanOrEqual(2); // stray→b1, stray→b2
    expect(a.cohesion).toBeLessThan(1);
  });

  it("flags stray() as a misfit attracted to /proj/b", async () => {
    const { evaluation } = await evaluateModulesFromGraph(graph, functions, "dir");
    const stray = evaluation.misfits.find((m) => m.name === "stray");
    expect(stray).toBeDefined();
    expect(stray!.attractedTo).toBe("/proj/b");
    expect(stray!.attractedTies).toBeGreaterThan(stray!.homeTies);
  });

  it("modularity is a finite number in [-0.5, 1]", async () => {
    const { evaluation } = await evaluateModulesFromGraph(graph, functions, "dir");
    expect(Number.isFinite(evaluation.modularity)).toBe(true);
    expect(evaluation.modularity).toBeGreaterThanOrEqual(-0.5);
    expect(evaluation.modularity).toBeLessThanOrEqual(1);
  });
});
