/**
 * src/graph/__tests__/traverse.test.ts — the single shared reachability walk.
 */

import { describe, it, expect } from "vitest";
import { InMemoryCodeGraph } from "../in-memory.js";
import type { CodeGraph } from "../build.js";
import type { AnchorId, CodeNode, Edge } from "../../types.js";
import { reachClosure, reachFrom } from "../traverse.js";

function a(id: string): AnchorId {
  return id as AnchorId;
}

function node(id: string): CodeNode {
  return {
    id: a(id),
    name: id,
    kind: "function",
    sourceRange: { start: { line: 1, column: 0 }, end: { line: 2, column: 0 }, filePath: `/repo/${id}.ts` },
  };
}

function graphOf(ids: string[], pairs: [string, string][], kind: Edge["kind"] = "calls"): InMemoryCodeGraph {
  const edges: Edge[] = pairs.map(([from, to]) => ({ from: a(from), to: a(to), kind }));
  const adjacency = new Map<AnchorId, Edge[]>();
  const reverseAdjacency = new Map<AnchorId, Edge[]>();
  for (const edge of edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge]);
    reverseAdjacency.set(edge.to, [...(reverseAdjacency.get(edge.to) ?? []), edge]);
  }
  const graph: CodeGraph = {
    nodes: new Map(ids.map((id) => [a(id), node(id)])),
    adjacency,
    reverseAdjacency,
    edges,
  };
  return new InMemoryCodeGraph(graph);
}

describe("reachFrom", () => {
  it("records the minimum hop count, not the discovery order", async () => {
    // "d" is reachable in 1 hop via c and in 2 hops via a→b→d.
    const graph = graphOf(["a", "b", "c", "d"], [["a", "b"], ["b", "d"], ["a", "d"]]);
    const { steps } = await reachFrom(graph, [a("a")]);
    expect(steps.get(a("a"))).toEqual({ distance: 0, via: null, viaKind: null });
    expect(steps.get(a("d"))?.distance).toBe(1);
  });

  it("breaks a shortest-path tie on the lowest parent anchor", async () => {
    const graph = graphOf(["root", "mid-b", "mid-a", "leaf"],
      [["root", "mid-b"], ["root", "mid-a"], ["mid-b", "leaf"], ["mid-a", "leaf"]]);
    const first = await reachFrom(graph, [a("root")]);
    const second = await reachFrom(graph, [a("root")]);
    expect(first.steps.get(a("leaf"))?.via).toBe(a("mid-a"));
    expect(second.steps.get(a("leaf"))?.via).toBe(a("mid-a"));
  });

  it("stops at maxDepth and reports that it did", async () => {
    const graph = graphOf(["a", "b", "c"], [["a", "b"], ["b", "c"]]);
    const capped = await reachFrom(graph, [a("a")], { maxDepth: 1 });
    expect([...capped.steps.keys()].sort()).toEqual([a("a"), a("b")]);
    expect(capped.depthLimited).toBe(true);

    const complete = await reachFrom(graph, [a("a")], { maxDepth: 2 });
    expect(complete.depthLimited).toBe(false);
  });

  it("follows only the requested edge kinds", async () => {
    const graph = graphOf(["a", "b"], [["a", "b"]], "reads");
    expect((await reachFrom(graph, [a("a")])).steps.size).toBe(1);
    expect((await reachFrom(graph, [a("a")], { edgeKinds: ["reads"] })).steps.size).toBe(2);
  });

  it("terminates on a cycle", async () => {
    const graph = graphOf(["a", "b"], [["a", "b"], ["b", "a"]]);
    expect((await reachClosure(graph, [a("a")])).size).toBe(2);
  });
});

describe("reachClosure", () => {
  it("returns the entry set unioned with everything reachable", async () => {
    const graph = graphOf(["a", "b", "c", "x"], [["a", "b"], ["b", "c"]]);
    expect([...await reachClosure(graph, [a("a")])].sort()).toEqual([a("a"), a("b"), a("c")]);
  });
});
