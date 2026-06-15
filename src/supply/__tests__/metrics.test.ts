/**
 * T26 — Tests for metrics.ts + thresholds.ts.
 *
 * Uses a hand-built CodeGraph for precise edge control (the field-access
 * heuristic for reads/writes is brittle to set up via real source), plus the
 * percentile maths.
 */

import { describe, it, expect } from "vitest";
import { InMemoryCodeGraph } from "../../graph/in-memory.js";
import type { CodeGraph } from "../../graph/build.js";
import type { AnchorId, CodeNode, Edge } from "../../types.js";
import { computeMetrics } from "../metrics.js";
import { deriveThresholds, percentile, isFlagged } from "../thresholds.js";

function a(id: string): AnchorId {
  return id as unknown as AnchorId;
}

/** Build a CodeGraph from node ids + typed edges. */
function makeGraph(ids: string[], edges: Edge[]): InMemoryCodeGraph {
  const nodes = new Map<AnchorId, CodeNode>();
  const adjacency = new Map<AnchorId, Edge[]>();
  const reverseAdjacency = new Map<AnchorId, Edge[]>();
  for (const id of ids) {
    nodes.set(a(id), {
      id: a(id),
      name: id,
      kind: "function",
      sourceRange: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 }, filePath: `/${id}.cpp` },
    });
    adjacency.set(a(id), []);
    reverseAdjacency.set(a(id), []);
  }
  for (const e of edges) {
    adjacency.get(e.from)!.push(e);
    reverseAdjacency.get(e.to)!.push(e);
  }
  const graph: CodeGraph = { nodes, adjacency, reverseAdjacency, edges };
  return new InMemoryCodeGraph(graph);
}

describe("T26 computeMetrics", () => {
  it("counts shared-state fan-in over reads+writes edges", async () => {
    // f1, f2, f3 all write/read a 'state' node.
    const edges: Edge[] = [
      { from: a("f1"), to: a("state"), kind: "writes" },
      { from: a("f2"), to: a("state"), kind: "reads" },
      { from: a("f3"), to: a("state"), kind: "reads" },
    ];
    const g = makeGraph(["f1", "f2", "f3", "state"], edges);
    const metrics = await computeMetrics(g);
    const state = metrics.find((m) => m.anchor === a("state"))!;
    expect(state.sharedStateFanIn).toBe(3);
  });

  it("counts domain overlap (domains touching one entity)", async () => {
    const g = makeGraph(["e1", "e2"], []);
    const membership = new Map<string, AnchorId[]>([
      ["combat", [a("e1")]],
      ["ui", [a("e1")]],
      ["save", [a("e2")]],
    ]);
    const metrics = await computeMetrics(g, membership);
    const e1 = metrics.find((m) => m.anchor === a("e1"))!;
    const e2 = metrics.find((m) => m.anchor === a("e2"))!;
    expect(e1.domainOverlap).toBe(2); // combat + ui
    expect(e2.domainOverlap).toBe(1);
  });

  it("computes cross-domain dependency depth", async () => {
    // chain f1 -> f2 -> f3, where f1 in 'A', f2/f3 in 'B' => boundary at f1->f2.
    const edges: Edge[] = [
      { from: a("f1"), to: a("f2"), kind: "calls" },
      { from: a("f2"), to: a("f3"), kind: "calls" },
    ];
    const g = makeGraph(["f1", "f2", "f3"], edges);
    const membership = new Map<string, AnchorId[]>([
      ["A", [a("f1")]],
      ["B", [a("f2"), a("f3")]],
    ]);
    const metrics = await computeMetrics(g, membership);
    const f1 = metrics.find((m) => m.anchor === a("f1"))!;
    // f1->f2 crosses (depth 1), f2->f3 same domain (still counts toward chain) => depth 2.
    expect(f1.crossDomainDepth).toBe(2);
  });

  it("computes auxiliary fan-in/out/coupling and cyclomatic", async () => {
    const edges: Edge[] = [
      { from: a("caller"), to: a("callee"), kind: "calls" },
    ];
    const g = makeGraph(["caller", "callee"], edges);
    const metrics = await computeMetrics(g);
    const caller = metrics.find((m) => m.anchor === a("caller"))!;
    const callee = metrics.find((m) => m.anchor === a("callee"))!;
    expect(caller.fanOut).toBe(1);
    expect(caller.cyclomatic).toBe(2); // calls out-degree 1 + 1
    expect(callee.fanIn).toBe(1);
    expect(callee.coupling).toBe(1);
  });

  it("returns metrics in deterministic anchor order", async () => {
    const g = makeGraph(["z", "a", "m"], []);
    const m1 = await computeMetrics(g);
    const m2 = await computeMetrics(g);
    expect(m1.map((m) => m.anchor)).toEqual(m2.map((m) => m.anchor));
    expect(m1.map((m) => m.anchor)).toEqual([...m1.map((m) => m.anchor)].sort());
  });
});

describe("T26 thresholds", () => {
  it("percentile interpolates (R-7)", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5);
    expect(percentile([10], 0.95)).toBe(10);
    expect(percentile([], 0.5)).toBe(0);
  });

  it("derives median + upper percentile from the repo distribution", async () => {
    const g = makeGraph(["n"], []);
    // Fabricate metrics by overriding: easier to feed deriveThresholds directly.
    const metrics = await computeMetrics(g);
    void metrics;
    const fake = [0, 1, 2, 3, 4, 5, 6, 7, 8, 100].map((v) => ({
      anchor: a(`x${v}`),
      domainOverlap: 0,
      sharedStateFanIn: 0,
      crossDomainDepth: 0,
      cyclomatic: 0,
      fanIn: 0,
      fanOut: 0,
      coupling: v,
    }));
    const th = deriveThresholds(fake, { upperPercentile: 0.9 });
    expect(th.coupling.median).toBeGreaterThan(0);
    // 100 is the outlier; values below p90 are not flagged, 100 is.
    expect(isFlagged(th, "coupling", 100)).toBe(true);
    expect(isFlagged(th, "coupling", 2)).toBe(false);
  });
});
