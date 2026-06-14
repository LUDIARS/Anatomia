/**
 * T13 — Tests for KuzuCodeGraph (kuzu.ts).
 *
 * Projects the same graph used in in-memory.test.ts into Kuzu and verifies
 * the same CodeGraphQuery semantics.
 *
 * Kuzu install status: INSTALLED & WORKING (kuzu@0.11.3, ships prebuilt
 * binaries, no native build required on this machine).
 *
 * Known quirk: kuzu 0.11 may segfault on explicit db.close() / conn.close()
 * on some Windows environments.  KuzuCodeGraph.close() swallows the error.
 * The afterAll() guard below wraps close() in try/catch.
 *
 * extractEdgeInfo() is called before tree.delete() so AST walking completes
 * while WASM memory is live.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parse } from "../../dag/parser.js";
import { extractFunctions } from "../../dag/extract.js";
import { normalize } from "../../dag/normalize.js";
import { assignAnchorId } from "../../dag/hash.js";
import { buildFileNode } from "../../dag/merkle.js";
import { buildGraph, extractEdgeInfo } from "../build.js";
import { KuzuCodeGraph } from "../kuzu.js";
import type { FileNode, AnchorId } from "../../types.js";
import type { FunctionEdgeInfo } from "../build.js";

// ---------------------------------------------------------------------------
// Same fixture as in-memory.test.ts: A→B→C chain, D isolated, E↔F cycle.
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

let q: KuzuCodeGraph;
let idOf: Record<string, AnchorId>;

beforeAll(async () => {
  const { file, edgeInfo } = await makeFile(SRC, "/chain.cpp");
  const graph = buildGraph([file], edgeInfo);
  q = await KuzuCodeGraph.create(graph);
  idOf = {};
  for (const fn of file.functions) {
    idOf[fn.name] = fn.id!;
  }
}, 30_000);

afterAll(() => {
  try { q.close(); } catch (_) { /* kuzu 0.11 segfault guard */ }
});

// ---------------------------------------------------------------------------

describe("T13 KuzuCodeGraph — getNode / allNodes", () => {
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

describe("T13 KuzuCodeGraph — neighbors / predecessors", () => {
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

describe("T13 KuzuCodeGraph — edgesFrom / edgesTo", () => {
  it("edgesFrom(b_fn, 'calls') has edge to c_fn", async () => {
    const edges = await q.edgesFrom(idOf["b_fn"]!, "calls");
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.some((e) => e.to === idOf["c_fn"] && e.kind === "calls")).toBe(true);
  });

  it("edgesTo(c_fn, 'calls') has edge from b_fn", async () => {
    const edges = await q.edgesTo(idOf["c_fn"]!, "calls");
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.some((e) => e.from === idOf["b_fn"])).toBe(true);
  });
});

describe("T13 KuzuCodeGraph — edgesMatching", () => {
  it("edgesMatching({kind:'calls', toName:'c_fn'}) finds the b→c edge", async () => {
    const edges = await q.edgesMatching({ kind: "calls", toName: "c_fn" });
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.some((e) => e.to === idOf["c_fn"])).toBe(true);
  });

  it("edgesMatching({fromName:'a_fn'}) returns outgoing edges of a_fn", async () => {
    const edges = await q.edgesMatching({ fromName: "a_fn" });
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e) => e.from === idOf["a_fn"])).toBe(true);
  });
});

describe("T13 KuzuCodeGraph — fanCounts (traceability queries)", () => {
  it("b_fn fan-in=1 (called by a), fan-out>=1 (calls c)", async () => {
    const { fanIn, fanOut } = await q.fanCounts(idOf["b_fn"]!);
    expect(fanIn).toBe(1);
    expect(fanOut).toBeGreaterThanOrEqual(1);
  });

  it("c_fn fan-in=1, fan-out=0 (leaf)", async () => {
    const { fanIn, fanOut } = await q.fanCounts(idOf["c_fn"]!);
    expect(fanIn).toBe(1);
    expect(fanOut).toBe(0);
  });

  it("d_fn fan-in=0, fan-out=0 (isolated)", async () => {
    const { fanIn, fanOut } = await q.fanCounts(idOf["d_fn"]!);
    expect(fanIn).toBe(0);
    expect(fanOut).toBe(0);
  });
});

describe("T13 KuzuCodeGraph — reachable / isReachable", () => {
  it("reachable(a_fn) includes b_fn and c_fn", async () => {
    const nodes = await q.reachable(idOf["a_fn"]!);
    const names = nodes.map((n) => n.name);
    expect(names).toContain("b_fn");
    expect(names).toContain("c_fn");
  });

  it("isReachable(a_fn → c_fn) = true", async () => {
    expect(await q.isReachable(idOf["a_fn"]!, idOf["c_fn"]!)).toBe(true);
  });

  it("isReachable(c_fn → a_fn) = false", async () => {
    expect(await q.isReachable(idOf["c_fn"]!, idOf["a_fn"]!)).toBe(false);
  });

  it("isReachable(d_fn → anything) = false", async () => {
    expect(await q.isReachable(idOf["d_fn"]!, idOf["a_fn"]!)).toBe(false);
  });

  it("reachable terminates on mutual cycle e↔f", async () => {
    const nodes = await q.reachable(idOf["e_fn"]!);
    const names = nodes.map((n) => n.name);
    expect(names).toContain("f_fn");
  });

  it("reachable with both directions walks incoming and outgoing edges", async () => {
    const nodes = await q.reachable(idOf["b_fn"]!, { direction: "both", maxDepth: 1 });
    const names = nodes.map((n) => n.name);
    expect(names).toContain("a_fn");
    expect(names).toContain("c_fn");
  });
});
