/**
 * T12 — Tests for InMemoryCodeGraph (in-memory.ts).
 *
 * Verifies that the CodeGraphQuery interface is correctly implemented:
 * getNode, allNodes, neighbors, predecessors, edgesFrom, edgesTo,
 * edgesMatching, fanCounts, reachable, isReachable.
 *
 * extractEdgeInfo() is called before tree.delete() so AST walking
 * completes while WASM memory is live.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { parse } from "../../dag/parser.js";
import { extractFunctions } from "../../dag/extract.js";
import { normalize } from "../../dag/normalize.js";
import { assignAnchorId } from "../../dag/hash.js";
import { buildFileNode } from "../../dag/merkle.js";
import { buildGraph, extractEdgeInfo } from "../build.js";
import { InMemoryCodeGraph } from "../in-memory.js";
import type { FileNode, AnchorId } from "../../types.js";
import type { FunctionEdgeInfo } from "../build.js";

// ---------------------------------------------------------------------------
// Setup: A→B→C linear chain, plus D (isolated), and a mutual cycle E↔F.
// ---------------------------------------------------------------------------

async function makeFile(
  src: string,
  path: string,
): Promise<{ file: FileNode; edgeInfo: Map<AnchorId, FunctionEdgeInfo> }> {
  const tree = await parse(src, "cpp");
  const fns = extractFunctions(tree, src, path);
  for (const fn of fns) assignAnchorId(fn, normalize(fn.bodyAst));
  const file = buildFileNode(path, fns);
  const edgeInfo = extractEdgeInfo([file]);  // before tree.delete()
  tree.delete();
  return { file, edgeInfo };
}

// A calls B, B calls C; D is isolated; E and F call each other.
// All bodies are structurally distinct so their AnchorIds are unique.
const SRC = `
int c_fn() { return 3; }
int b_fn() { return c_fn() + 2; }
int a_fn() { return b_fn() + 1; }
int d_fn() { return 99; }
void f_fn();
void e_fn() { f_fn(); }
void f_fn() { e_fn(); }
`;

let q: InMemoryCodeGraph;
let idOf: Record<string, AnchorId>;

beforeAll(async () => {
  const { file, edgeInfo } = await makeFile(SRC, "/chain.cpp");
  const graph = buildGraph([file], edgeInfo);
  q = new InMemoryCodeGraph(graph);
  idOf = {};
  for (const fn of file.functions) {
    idOf[fn.name] = fn.id!;
  }
});

// ---------------------------------------------------------------------------

describe("T12 InMemoryCodeGraph — getNode / allNodes", () => {
  it("getNode returns the correct node", async () => {
    const node = await q.getNode(idOf["a_fn"]!);
    expect(node).toBeDefined();
    expect(node!.name).toBe("a_fn");
  });

  it("getNode returns undefined for unknown id", async () => {
    const node = await q.getNode("deadbeef00000000" as AnchorId);
    expect(node).toBeUndefined();
  });

  it("allNodes returns all 6 functions", async () => {
    const nodes = await q.allNodes();
    expect(nodes.length).toBe(6);
  });
});

describe("T12 InMemoryCodeGraph — neighbors / predecessors", () => {
  it("neighbors(a_fn) includes b_fn", async () => {
    const nbrs = await q.neighbors(idOf["a_fn"]!);
    expect(nbrs.map((n) => n.name)).toContain("b_fn");
  });

  it("neighbors(a_fn, 'calls') includes b_fn", async () => {
    const nbrs = await q.neighbors(idOf["a_fn"]!, "calls");
    expect(nbrs.map((n) => n.name)).toContain("b_fn");
  });

  it("neighbors(d_fn) = [] (isolated)", async () => {
    const nbrs = await q.neighbors(idOf["d_fn"]!);
    expect(nbrs).toHaveLength(0);
  });

  it("predecessors(c_fn) includes b_fn", async () => {
    const preds = await q.predecessors(idOf["c_fn"]!);
    expect(preds.map((n) => n.name)).toContain("b_fn");
  });

  it("predecessors(a_fn) = [] (root)", async () => {
    const preds = await q.predecessors(idOf["a_fn"]!);
    expect(preds).toHaveLength(0);
  });
});

describe("T12 InMemoryCodeGraph — edgesFrom / edgesTo", () => {
  it("edgesFrom(b_fn, 'calls') has edge to c_fn", async () => {
    const edges = await q.edgesFrom(idOf["b_fn"]!, "calls");
    expect(edges.length).toBeGreaterThan(0);
    expect(edges[0]!.to).toBe(idOf["c_fn"]);
    expect(edges[0]!.kind).toBe("calls");
  });

  it("edgesTo(c_fn, 'calls') has edge from b_fn", async () => {
    const edges = await q.edgesTo(idOf["c_fn"]!, "calls");
    expect(edges.length).toBeGreaterThan(0);
    expect(edges[0]!.from).toBe(idOf["b_fn"]);
  });
});

describe("T12 InMemoryCodeGraph — edgesMatching", () => {
  it("edgesMatching({kind:'calls', toName:'c_fn'}) finds the b→c edge", async () => {
    const edges = await q.edgesMatching({ kind: "calls", toName: "c_fn" });
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e) => e.kind === "calls")).toBe(true);
    expect(edges.map((e) => e.to)).toContain(idOf["c_fn"]);
  });

  it("edgesMatching({fromName:'a_fn'}) returns all outgoing edges of a_fn", async () => {
    const edges = await q.edgesMatching({ fromName: "a_fn" });
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e) => e.from === idOf["a_fn"])).toBe(true);
  });
});

describe("T12 InMemoryCodeGraph — fanCounts", () => {
  it("b_fn has fanIn=1 (called by a_fn), fanOut>=1 (calls c_fn)", async () => {
    const { fanIn, fanOut } = await q.fanCounts(idOf["b_fn"]!);
    expect(fanIn).toBe(1);
    expect(fanOut).toBeGreaterThanOrEqual(1);
  });

  it("c_fn has fanIn=1, fanOut=0", async () => {
    const { fanIn, fanOut } = await q.fanCounts(idOf["c_fn"]!);
    expect(fanIn).toBe(1);
    expect(fanOut).toBe(0);
  });

  it("d_fn has fanIn=0, fanOut=0", async () => {
    const { fanIn, fanOut } = await q.fanCounts(idOf["d_fn"]!);
    expect(fanIn).toBe(0);
    expect(fanOut).toBe(0);
  });
});

describe("T12 InMemoryCodeGraph — reachable / isReachable", () => {
  it("reachable(a_fn) includes b_fn and c_fn", async () => {
    const nodes = await q.reachable(idOf["a_fn"]!);
    const names = nodes.map((n) => n.name);
    expect(names).toContain("b_fn");
    expect(names).toContain("c_fn");
  });

  it("reachable(a_fn, maxDepth=1) = only b_fn (not c_fn)", async () => {
    const nodes = await q.reachable(idOf["a_fn"]!, { maxDepth: 1 });
    const names = nodes.map((n) => n.name);
    expect(names).toContain("b_fn");
    expect(names).not.toContain("c_fn");
  });

  it("isReachable(a_fn → c_fn) = true", async () => {
    expect(await q.isReachable(idOf["a_fn"]!, idOf["c_fn"]!)).toBe(true);
  });

  it("isReachable(c_fn → a_fn) = false (no back edge)", async () => {
    expect(await q.isReachable(idOf["c_fn"]!, idOf["a_fn"]!)).toBe(false);
  });

  it("isReachable(d_fn → anything) = false", async () => {
    expect(await q.isReachable(idOf["d_fn"]!, idOf["a_fn"]!)).toBe(false);
  });

  it("reachable handles mutual cycle (e↔f) without infinite loop", async () => {
    const fromE = await q.reachable(idOf["e_fn"]!);
    const names = fromE.map((n) => n.name);
    expect(names).toContain("f_fn");
  });

  it("reachable with incoming direction: predecessors of c_fn include a_fn", async () => {
    const nodes = await q.reachable(idOf["c_fn"]!, { direction: "incoming" });
    const names = nodes.map((n) => n.name);
    expect(names).toContain("b_fn");
    expect(names).toContain("a_fn");
  });

  it("reachable with both directions walks incoming and outgoing edges", async () => {
    const nodes = await q.reachable(idOf["b_fn"]!, { direction: "both", maxDepth: 1 });
    const names = nodes.map((n) => n.name);
    expect(names).toContain("a_fn");
    expect(names).toContain("c_fn");
  });
});

describe("T12 InMemoryCodeGraph duplicate implementation shapes", () => {
  it("keeps distinct functions with identical bodies as separate nodes", async () => {
    const { file, edgeInfo } = await makeFile(
      "int first_same() { return 1; }\nint second_same() { return 1; }\n",
      "/duplicates.cpp",
    );
    const graph = buildGraph([file], edgeInfo);
    const graphQuery = new InMemoryCodeGraph(graph);
    const nodes = await graphQuery.allNodes();

    expect(nodes.map((n) => n.name).sort()).toEqual(["first_same", "second_same"]);
    expect(new Set(nodes.map((n) => n.id)).size).toBe(2);
  });
});
