/**
 * buildDomainReview — deterministic per-domain review over a hand-built
 * synthetic context (nodes + calls edges + detection results). Hermetic: no
 * repo analysis, every expected number is derivable from the fixture by hand.
 */

import { describe, it, expect } from "vitest";
import { InMemoryCodeGraph } from "../../graph/in-memory.js";
import type { CodeGraph } from "../../graph/build.js";
import type { AnalysisContext } from "../../core.js";
import type { AnchorId, CodeNode, Edge, Link } from "../../types.js";
import type { DetectionResult } from "../../domains/detect.js";
import { buildDomainReview, type DomainDefWithSpecs } from "../domain-review.js";
import { formatDomainReview } from "../domain-review-format.js";

const A = (s: string): AnchorId => s as AnchorId;

function node(id: string, file: string, line: number): CodeNode {
  return {
    id: A(id),
    name: id,
    kind: "function",
    sourceRange: {
      start: { line: line - 1, column: 0 },
      end: { line: line - 1, column: 1 },
      filePath: `/repo/${file}`,
    },
  };
}

function call(from: string, to: string): Edge {
  return { from: A(from), to: A(to), kind: "calls" };
}

function makeGraph(nodes: CodeNode[], edges: Edge[]): InMemoryCodeGraph {
  const graph: CodeGraph = {
    nodes: new Map(nodes.map((n) => [n.id, n])),
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

function detection(domain: string, implementors: string[], conforms = true): DetectionResult {
  return { domain, implementors: implementors.map(A), violations: [], conforms };
}

/**
 * Fixture: two domains A (a1..a4 + shared ab) and B (b1, b2 + shared ab), one
 * unassigned function u1.
 *
 * calls edges              A-classification   B-classification
 *   a1 -> a2               internal
 *   a2 -> a3               internal
 *   a1 -> b1               boundary           boundary
 *   b1 -> b2                                  internal
 *   a4 -> u1               boundary
 *   ab -> b2               boundary           internal
 *
 * => A: internal 2, boundary 3, isolated {a4, ab}; B: internal 2, boundary 1.
 */
function makeCtx(overrides: Partial<AnalysisContext> = {}): AnalysisContext {
  const nodes = [
    node("a1", "src/a/a1.cpp", 1),
    node("a2", "src/a/a2.cpp", 1),
    node("a3", "src/a/a3.cpp", 1),
    node("a4", "src/a/a4.cpp", 1),
    node("ab", "src/shared/ab.cpp", 1),
    node("b1", "src/b/b1.cpp", 1),
    node("b2", "src/b/b2.cpp", 1),
    node("u1", "src/util/u1.cpp", 1),
  ];
  const edges = [
    call("a1", "a2"),
    call("a2", "a3"),
    call("a1", "b1"),
    call("b1", "b2"),
    call("a4", "u1"),
    call("ab", "b2"),
  ];
  return {
    repoPath: "/repo",
    graph: makeGraph(nodes, edges),
    files: [],
    functions: [],
    domains: [
      detection("A", ["a1", "a2", "a3", "a4", "ab"]),
      detection("B", ["ab", "b1", "b2"]),
    ],
    ...overrides,
  };
}

function def(name: string, specRefs: string[]): DomainDefWithSpecs {
  return { name, description: name, presetRules: [], templateRules: [], specRefs };
}

describe("buildDomainReview", () => {
  it("computes coverage and lists unassigned functions", async () => {
    const r = await buildDomainReview(makeCtx());
    expect(r.summary.functions).toBe(8);
    expect(r.summary.assigned).toBe(7);
    expect(r.summary.coverage).toBeCloseTo(7 / 8, 10);
    expect(r.summary.unassigned).toBe(1);
    expect(r.unassigned.map((l) => l.name)).toEqual(["u1"]);
    expect(r.unassigned[0]!.file).toBe("src/util/u1.cpp");
  });

  it("computes per-domain internal/boundary edges and the cohesion ratio", async () => {
    const r = await buildDomainReview(makeCtx());
    const a = r.domains.find((d) => d.domain === "A")!;
    const b = r.domains.find((d) => d.domain === "B")!;
    expect(a.internalEdges).toBe(2);
    expect(a.boundaryEdges).toBe(3);
    expect(a.cohesion).toBeCloseTo(2 / 5, 10);
    expect(b.internalEdges).toBe(2);
    expect(b.boundaryEdges).toBe(1);
    expect(b.cohesion).toBeCloseTo(2 / 3, 10);
  });

  it("reports null cohesion for a domain touching no calls edge", async () => {
    const ctx: AnalysisContext = {
      repoPath: "/repo",
      graph: makeGraph([node("iso", "src/iso.cpp", 1)], []),
      files: [],
      functions: [],
      domains: [detection("lonely", ["iso"])],
    };
    const r = await buildDomainReview(ctx);
    expect(r.domains[0]!.cohesion).toBeNull();
    expect(r.domains[0]!.internalEdges).toBe(0);
    expect(r.domains[0]!.boundaryEdges).toBe(0);
  });

  it("detects membership drift (implementors isolated from same-domain peers)", async () => {
    const r = await buildDomainReview(makeCtx());
    const a = r.domains.find((d) => d.domain === "A")!;
    // a4 only calls the unassigned u1; ab only calls into B — both drift.
    expect(a.isolated.map((l) => l.name).sort()).toEqual(["a4", "ab"]);
    expect(a.isolatedCount).toBe(2);
    const b = r.domains.find((d) => d.domain === "B")!;
    expect(b.isolatedCount).toBe(0);
    expect(r.summary.isolated).toBe(2);
  });

  it("does not flag a single-implementor domain as drift (no peers exist)", async () => {
    const ctx = makeCtx({ domains: [detection("solo", ["a1"])] });
    const r = await buildDomainReview(ctx);
    expect(r.domains[0]!.isolatedCount).toBe(0);
    expect(r.summary.isolated).toBe(0);
  });

  it("lists functions claimed by multiple domains as overlap", async () => {
    const r = await buildDomainReview(makeCtx());
    expect(r.summary.overlap).toBe(1);
    expect(r.overlap).toHaveLength(1);
    expect(r.overlap[0]!.name).toBe("ab");
    expect(r.overlap[0]!.domains).toEqual(["A", "B"]);
  });

  it("warns when a domain declares specRefs but no implementor is spec-linked", async () => {
    // A is linked via a function anchor; B declares specRefs but has no link.
    const links: Link[] = [{ from: A("a1"), to: "clause-1", confidence: 1, evidence: "explicit" }];
    const r = await buildDomainReview(makeCtx({ links }), {
      domainDefs: [def("A", ["§1 / alpha"]), def("B", ["§2 / beta"])],
    });
    expect(r.specIntegrity).toHaveLength(1);
    expect(r.specIntegrity[0]!.domain).toBe("B");
    expect(r.specIntegrity[0]!.specRefs).toEqual(["§2 / beta"]);
    expect(r.specIntegrity[0]!.implementors).toBe(3);
    expect(r.summary.specIntegrity).toBe(1);
  });

  it("accepts file-granular links (link source = implementor's source path)", async () => {
    const links: Link[] = [
      { from: "/repo/src/b/b1.cpp" as AnchorId, to: "clause-2", confidence: 1, evidence: "structural" },
    ];
    const r = await buildDomainReview(makeCtx({ links }), {
      domainDefs: [def("B", ["§2 / beta"])],
    });
    expect(r.specIntegrity).toHaveLength(0);
  });

  it("skips spec integrity for undetected domains and when defs are absent", async () => {
    const withUndetected = await buildDomainReview(makeCtx(), {
      domainDefs: [def("ghost", ["§9 / ghost"])],
    });
    expect(withUndetected.specIntegrity).toHaveLength(0);
    const withoutDefs = await buildDomainReview(makeCtx());
    expect(withoutDefs.specIntegrity).toHaveLength(0);
  });

  it("caps lists via maxList while keeping true counts in the summary", async () => {
    const r = await buildDomainReview(makeCtx(), { maxList: 1 });
    const a = r.domains.find((d) => d.domain === "A")!;
    expect(a.isolated).toHaveLength(1);
    expect(a.isolatedCount).toBe(2);
    expect(r.summary.isolated).toBe(2);
  });

  it("is deterministic (same context → identical report)", async () => {
    const ctx = makeCtx();
    const a = await buildDomainReview(ctx);
    const b = await buildDomainReview(ctx);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("formatDomainReview renders the sections as text", async () => {
    const links: Link[] = [];
    const r = await buildDomainReview(makeCtx({ links }), {
      domainDefs: [def("B", ["§2 / beta"])],
    });
    const text = formatDomainReview(r);
    expect(text).toContain("Domain review of /repo");
    expect(text).toContain("# Domains");
    expect(text).toContain("# Unassigned functions");
    expect(text).toContain("# Domain overlap");
    expect(text).toContain("# Spec integrity");
    expect(text).toContain("isolated members");
  });
});
