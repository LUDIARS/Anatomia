/**
 * detectBoundaryDrift — deterministic label propagation over hand-built calls
 * graphs. Hermetic: every expected finding is derivable from the fixture by
 * hand (seeds, rounds, majority votes).
 */

import { describe, it, expect } from "vitest";
import { InMemoryCodeGraph } from "../../graph/in-memory.js";
import type { CodeGraph } from "../../graph/build.js";
import type { AnchorId, CodeNode, Edge } from "../../types.js";
import type { DetectionResult } from "../../domains/detect.js";
import { detectBoundaryDrift } from "../boundary.js";

const A = (s: string): AnchorId => s as AnchorId;

function node(id: string): CodeNode {
  return {
    id: A(id),
    name: id,
    kind: "function",
    sourceRange: {
      start: { line: 0, column: 0 },
      end: { line: 0, column: 1 },
      filePath: `/repo/src/${id}.cpp`,
    },
  };
}

function call(from: string, to: string): Edge {
  return { from: A(from), to: A(to), kind: "calls" };
}

function makeGraph(ids: string[], edges: Edge[]): InMemoryCodeGraph {
  const graph: CodeGraph = {
    nodes: new Map(ids.map((id) => [A(id), node(id)])),
    adjacency: new Map(),
    reverseAdjacency: new Map(),
    edges,
  };
  for (const e of edges) {
    const out = graph.adjacency.get(e.from) ?? [];
    out.push(e);
    graph.adjacency.set(e.from, out);
    const inc = graph.reverseAdjacency.get(e.to) ?? [];
    inc.push(e);
    graph.reverseAdjacency.set(e.to, inc);
  }
  return new InMemoryCodeGraph(graph);
}

function detection(domain: string, implementors: string[]): DetectionResult {
  return { domain, implementors: implementors.map(A), violations: [], conforms: true };
}

describe("detectBoundaryDrift", () => {
  /**
   * X = {x1,x2,x3}, Y = {y1,y2,y3}. x3 is assigned to X but its only calls
   * neighbours are y1 and y2 → majority Y with 2 votes → drift.
   */
  const crossingGraph = () =>
    makeGraph(
      ["x1", "x2", "x3", "y1", "y2", "y3"],
      [call("x1", "x2"), call("y1", "y2"), call("y2", "y3"), call("x3", "y1"), call("y2", "x3")],
    );
  const crossingDetections = [detection("X", ["x1", "x2", "x3"]), detection("Y", ["y1", "y2", "y3"])];

  it("flags a seed whose calls neighbourhood majority is another domain", async () => {
    const findings = await detectBoundaryDrift(crossingGraph(), crossingDetections);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.anchor).toBe("x3");
    expect(f.domain).toBe("X");
    expect(f.suggested).toBe("Y");
    expect(f.votes).toEqual([{ domain: "Y", count: 2 }]);
  });

  it("requires >= 2 majority votes (a single dissenting neighbour is noise)", async () => {
    // y1's neighbourhood is {y2: Y, x3: X} — tie at 1 vote each → no finding.
    const findings = await detectBoundaryDrift(crossingGraph(), crossingDetections);
    expect(findings.some((f) => f.anchor === "y1")).toBe(false);
  });

  it("counts propagated (non-seed) labels in the phase-2 majority", async () => {
    // shell = {p1,p2}, core = {q1,q2,q3}; w1/w2 are unlabeled. w1 inherits core
    // (2 votes from q1,q3 vs 1 from p2); w2 ties between w1 (core) and p2
    // (shell) → lexicographically smallest "core" wins. Seed p2 then sees
    // {p1: shell, w1: core, w2: core} → drift toward core on propagated labels.
    const graph = makeGraph(
      ["p1", "p2", "q1", "q2", "q3", "w1", "w2"],
      [
        call("p1", "p2"),
        call("q1", "q2"),
        call("q2", "q3"),
        call("q1", "w1"),
        call("q3", "w1"),
        call("w1", "w2"),
        call("p2", "w1"),
        call("p2", "w2"),
      ],
    );
    const findings = await detectBoundaryDrift(graph, [
      detection("shell", ["p1", "p2"]),
      detection("core", ["q1", "q2", "q3"]),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.anchor).toBe("p2");
    expect(findings[0]!.domain).toBe("shell");
    expect(findings[0]!.suggested).toBe("core");
    expect(findings[0]!.votes).toEqual([
      { domain: "core", count: 2 },
      { domain: "shell", count: 1 },
    ]);
  });

  it("seeds multi-membership nodes with the lexicographically smallest domain", async () => {
    // m belongs to both M and N → seeded as M; its neighbours are two N nodes.
    const graph = makeGraph(
      ["m", "m1", "n1", "n2"],
      [call("m", "n1"), call("m", "n2"), call("n1", "n2")],
    );
    const findings = await detectBoundaryDrift(graph, [
      detection("N", ["m", "n1", "n2"]),
      detection("M", ["m", "m1"]),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.anchor).toBe("m");
    expect(findings[0]!.domain).toBe("M");
    expect(findings[0]!.suggested).toBe("N");
  });

  it("returns nothing without detections or for neighbour-free seeds", async () => {
    const graph = crossingGraph();
    expect(await detectBoundaryDrift(graph, [])).toEqual([]);
    // "solo" has one implementor with no calls edges → no majority → no finding.
    const soloGraph = makeGraph(["s1"], []);
    expect(await detectBoundaryDrift(soloGraph, [detection("solo", ["s1"])])).toEqual([]);
  });

  it("is deterministic (two runs produce identical findings)", async () => {
    const run = () => detectBoundaryDrift(crossingGraph(), crossingDetections);
    expect(JSON.stringify(await run())).toBe(JSON.stringify(await run()));
  });
});
