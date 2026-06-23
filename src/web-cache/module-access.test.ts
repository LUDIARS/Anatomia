/**
 * src/web-cache/module-access.test.ts — computeModuleAccesses.
 */

import { describe, it, expect } from "vitest";
import { InMemoryCodeGraph } from "../graph/in-memory.js";
import type { CodeGraph } from "../graph/build.js";
import type { AnchorId, CodeNode, Edge } from "../types.js";
import { computeModuleAccesses } from "./module-access.js";

function a(s: string): AnchorId {
  return s as AnchorId;
}

function node(id: string): CodeNode {
  return {
    id: a(id),
    name: id,
    kind: "function",
    sourceRange: {
      start: { line: 1, column: 0 },
      end: { line: 2, column: 0 },
      filePath: `/repo/${id}.ts`,
    },
  };
}

function makeGraph(nodes: CodeNode[], edges: Edge[]): InMemoryCodeGraph {
  const adjacency = new Map<AnchorId, Edge[]>();
  const reverseAdjacency = new Map<AnchorId, Edge[]>();
  for (const e of edges) {
    (adjacency.get(e.from) ?? adjacency.set(e.from, []).get(e.from)!).push(e);
    (reverseAdjacency.get(e.to) ?? reverseAdjacency.set(e.to, []).get(e.to)!).push(e);
  }
  const graph: CodeGraph = {
    nodes: new Map(nodes.map((n) => [n.id, n])),
    adjacency,
    reverseAdjacency,
    edges,
  };
  return new InMemoryCodeGraph(graph);
}

describe("computeModuleAccesses", () => {
  it("aggregates cross-module edges by kind, skipping intra-module ones", async () => {
    const nodes = [node("x1"), node("x2"), node("y1"), node("z1")];
    const edges: Edge[] = [
      { from: a("x1"), to: a("x2"), kind: "calls" }, // intra-module mX → skipped
      { from: a("x1"), to: a("y1"), kind: "calls" }, // mX → mY
      { from: a("x2"), to: a("y1"), kind: "reads" }, // mX → mY (different kind)
      { from: a("x1"), to: a("z1"), kind: "calls" }, // mX → mZ
    ];
    const moduleOf = (anchor: AnchorId): string | undefined =>
      ({ x1: "mX", x2: "mX", y1: "mY", z1: "mZ" })[anchor as string];

    const out = await computeModuleAccesses(makeGraph(nodes, edges), moduleOf, {
      labelOf: (m) => m.toUpperCase(),
      domainsOf: (m) => (m === "mY" ? ["dom-y"] : []),
    });

    const fromX = out.get("mX")!;
    expect(fromX).toBeDefined();
    // mY first (2 edges) then mZ (1 edge).
    expect(fromX.map((acc) => acc.targetModuleId)).toEqual(["mY", "mZ"]);
    const toY = fromX[0]!;
    expect(toY.count).toBe(2);
    expect(toY.kinds).toEqual({ calls: 1, reads: 1 });
    expect(toY.targetLabel).toBe("MY");
    expect(toY.targetDomains).toEqual(["dom-y"]);
    // mY and mZ have no outgoing edges.
    expect(out.has("mY")).toBe(false);
  });

  it("skips edges whose endpoint is in no tracked module", async () => {
    const nodes = [node("x1"), node("u1")];
    const edges: Edge[] = [{ from: a("x1"), to: a("u1"), kind: "calls" }];
    const out = await computeModuleAccesses(
      makeGraph(nodes, edges),
      (anchor) => (anchor === a("x1") ? "mX" : undefined),
      { labelOf: (m) => m, domainsOf: () => [] },
    );
    expect(out.size).toBe(0);
  });
});
