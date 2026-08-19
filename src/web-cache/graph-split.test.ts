/**
 * graph-split — overview aggregation + per-group slices with boundary
 * pseudo-nodes, deterministic and pruned.
 */

import { describe, it, expect } from "vitest";
import {
  buildGraphOverview,
  buildGraphSlices,
  boundaryNodeId,
  sliceKey,
  OVERVIEW_EDGES_PER_GROUP,
  SLICE_EDGE_CAP,
  SLICE_NODE_CAP,
} from "./graph-split.js";
import type { VisData, VisEdge, VisNode } from "../adapters/web/vis-data.js";

function node(id: string, group: string): VisNode {
  return {
    id,
    label: id,
    title: id,
    group,
    color: { background: "#000", border: "#111", highlight: { background: "#fff", border: "#222" } },
    size: 10,
    font: { color: "#eee", size: 10 },
    _meta: {
      name: id, kind: "function", file: `${group}/${id}.cpp`, line: 1, domain: "-",
      coupling: 0, cyclomatic: 1, fanIn: 0, fanOut: 0, domainOverlap: 0,
      crossDomainDepth: 0, memberAnchors: [id], memberCount: 1,
      lifecycle: null, lifecyclePhase: null, lifecycleEvents: [],
    },
  };
}

function edge(from: string, to: string): VisEdge {
  return {
    from, to, label: "calls", arrows: "to",
    font: { size: 8, color: "#666", strokeWidth: 0 },
    color: { color: "#123", opacity: 0.5 }, width: 1,
  };
}

function makeVisData(nodes: VisNode[], edges: VisEdge[]): VisData {
  const groups = [...new Set(nodes.map((n) => n.group))].sort();
  const base = {
    nodes, edges, groups,
    groupColors: {}, legend: [],
    summary: {
      title: "t", fileCount: 1, funcCount: nodes.length, nodeCount: nodes.length,
      edgeCount: edges.length, groupCount: groups.length, unresolvedCount: 0,
    },
  };
  return {
    ...base,
    unresolved: [],
    defaultView: "function",
    // Class view: same shape, one class node per group for simplicity.
    views: {
      class: {
        nodes: groups.map((g) => node(`class-${g}`, g)),
        edges: [],
        groups,
        groupColors: {},
        legend: [],
        summary: { ...base.summary, nodeCount: groups.length, edgeCount: 0 },
      },
    },
  };
}

describe("buildGraphOverview", () => {
  it("aggregates cross-group edges with counts and keeps groups sorted", () => {
    const data = makeVisData(
      [node("a1", "A"), node("a2", "A"), node("b1", "B")],
      [edge("a1", "b1"), edge("a2", "b1"), edge("a1", "a2")], // 2 cross, 1 intra
    );
    const overview = buildGraphOverview(data);
    expect(overview.schema).toBe("graph-overview-v1");
    expect(overview.groups.map((g) => g.name)).toEqual(["A", "B"]);
    expect(overview.groups[0]!.functionCount).toBe(2);
    expect(overview.overview.nodes.map((n) => n.label)).toEqual(["A", "B"]);
    expect(overview.overview.edges).toHaveLength(1); // A→B aggregated
    expect(overview.overview.edges[0]!.memberEdgeCount).toBe(2);
    expect(overview.prunedEdgeCount).toBe(0);
  });

  it("prunes per-group out-edges beyond the cap, strongest kept", () => {
    const nodes: VisNode[] = [node("hub", "HUB")];
    const edges: VisEdge[] = [];
    for (let i = 0; i < OVERVIEW_EDGES_PER_GROUP + 5; i++) {
      const group = `G${String(i).padStart(2, "0")}`;
      nodes.push(node(`n${i}`, group));
      // group Gi gets i+1 edges from hub → strongest are the last groups.
      for (let j = 0; j <= i; j++) edges.push(edge("hub", `n${i}`));
    }
    const overview = buildGraphOverview(makeVisData(nodes, edges));
    const outs = overview.overview.edges;
    expect(outs).toHaveLength(OVERVIEW_EDGES_PER_GROUP);
    expect(overview.prunedEdgeCount).toBe(5);
    // The weakest 5 pairs (counts 1..5) were pruned.
    expect(Math.min(...outs.map((e) => e.memberEdgeCount))).toBe(6);
  });
});

describe("buildGraphSlices", () => {
  it("splits nodes per group with intra edges and boundary pseudo nodes", () => {
    const data = makeVisData(
      [node("a1", "A"), node("a2", "A"), node("b1", "B")],
      [edge("a1", "a2"), edge("a1", "b1"), edge("a1", "b1")],
    );
    const slices = buildGraphSlices(data);
    const sliceA = slices.function[sliceKey("A")]!;
    expect(sliceA.name).toBe("A");
    expect(sliceA.nodes.map((n) => n.id).sort()).toEqual(["a1", "a2"]);
    // 1 intra edge + 1 aggregated boundary edge (a1 → @group:B ×2)
    const boundaryEdges = sliceA.edges.filter((e) => String(e.to).startsWith("@group:"));
    expect(boundaryEdges).toHaveLength(1);
    expect(boundaryEdges[0]!.to).toBe(boundaryNodeId(sliceKey("B")));
    expect(boundaryEdges[0]!.memberEdgeCount).toBe(2);
    expect(sliceA.boundary.map((b) => b.label)).toEqual(["B"]);

    // B side sees the aggregated INCOMING edge from the pseudo A node.
    const sliceB = slices.function[sliceKey("B")]!;
    const incoming = sliceB.edges.filter((e) => String(e.from).startsWith("@group:"));
    expect(incoming).toHaveLength(1);
    expect(incoming[0]!.from).toBe(boundaryNodeId(sliceKey("A")));
  });

  it("builds class-mode slices from the class view", () => {
    const data = makeVisData([node("a1", "A"), node("b1", "B")], []);
    const slices = buildGraphSlices(data);
    const classA = slices.class[sliceKey("A")]!;
    expect(classA.mode).toBe("class");
    expect(classA.nodes.map((n) => n.id)).toEqual(["class-A"]);
  });

  it("emits empty counterpart slices for groups present in only one mode", () => {
    const data = makeVisData([node("a1", "A")], []);
    data.views.class.nodes.push(node("class-C", "C"));

    const slices = buildGraphSlices(data);
    expect(slices.function[sliceKey("C")]!.nodes).toEqual([]);
    expect(slices.class[sliceKey("C")]!.nodes.map((n) => n.id)).toEqual(["class-C"]);
  });

  it("bounds a single oversized group and reports what was pruned", () => {
    const nodes = Array.from(
      { length: SLICE_NODE_CAP + 5 },
      (_, i) => node(`n${String(i).padStart(5, "0")}`, "A"),
    );
    const edges = Array.from(
      { length: SLICE_EDGE_CAP + 5 },
      () => edge("n00000", "n00001"),
    );

    const slice = buildGraphSlices(makeVisData(nodes, edges)).function[sliceKey("A")]!;
    expect(slice.nodes).toHaveLength(SLICE_NODE_CAP);
    expect(slice.edges).toHaveLength(SLICE_EDGE_CAP);
    expect(slice.totalNodeCount).toBe(SLICE_NODE_CAP + 5);
    expect(slice.totalEdgeCount).toBe(SLICE_EDGE_CAP + 5);
    expect(slice.prunedNodeCount).toBe(5);
    expect(slice.prunedEdgeCount).toBe(5);
  });

  it("keys are stable and file-safe", () => {
    expect(sliceKey("rendering")).toMatch(/^[0-9a-f]{16}$/);
    expect(sliceKey("rendering")).toBe(sliceKey("rendering"));
    expect(sliceKey("A")).not.toBe(sliceKey("B"));
  });
});
