import { describe, expect, it } from "vitest";
import { InMemoryCodeGraph } from "../../graph/in-memory.js";
import type { AnalysisContext } from "../../core.js";
import type { AnchorId, CodeNode, Edge } from "../../types.js";
import { buildReview } from "../build.js";
import { formatReview } from "../format.js";
import { buildDomainReview } from "../domain-review.js";
import { findRefactoringOpportunities } from "../refactoring-opportunities.js";
import { buildQualityScores } from "../quality-scores.js";

function context(empty = false): AnalysisContext {
  const ids = empty ? [] : ["a", "b", "c", "u"];
  const nodes = new Map(ids.map(id => [id as AnchorId, {
    id: id as AnchorId, name: id, kind: "function",
    sourceRange: { filePath: `/repo/${id}.ts`, start: { line: 0, column: 0 }, end: { line: 1, column: 0 } },
  } satisfies CodeNode]));
  const edges: Edge[] = empty ? [] : [{ from: "a" as AnchorId, to: "b" as AnchorId, kind: "calls" }];
  const adjacency = new Map<AnchorId, Edge[]>();
  const reverseAdjacency = new Map<AnchorId, Edge[]>();
  for (const e of edges) { adjacency.set(e.from, [e]); reverseAdjacency.set(e.to, [e]); }
  return { repoPath: "/repo", files: [], functions: [], graph: new InMemoryCodeGraph({ nodes, edges, adjacency, reverseAdjacency }),
    domains: empty ? [] : [
      { domain: "A", implementors: ["a", "c"].map(id => id as AnchorId), violations: [], conforms: true },
      { domain: "B", implementors: ["b", "c"].map(id => id as AnchorId), violations: [], conforms: true },
    ] };
}

describe("quality assessment", () => {
  it("publishes separate explainable scores and advisory source evidence through review", async () => {
    const report = await buildReview(context());
    const quality = report.quality!;
    expect(quality.population.functions).toBe(4);
    expect(quality.scores.dependencySimplicity).toMatchObject({ value: 94.12, numerator: 16, denominator: 17 });
    expect(quality.scores.domainCoverage.value).toBe(75);
    expect(quality.scores.domainSeparation.value).toBe(66.67);
    expect(quality.scores.domainCohesion.value).toBe(0);
    expect(quality.opportunities.items.find(item => item.kind === "overlapping-ownership")?.locations[0]?.name).toBe("c");
    expect(quality.opportunities.items.find(item => item.kind === "missing-ownership")?.locations[0]?.line).toBe(1);
    expect(formatReview(report)).toContain("not AST cyclomatic");
    expect(formatReview(report)).toContain("Refactoring opportunities");
    expect((await buildReview(context())).quality).toEqual(quality);
  });

  it("does not award perfect scores for empty analysis or missing domain declarations", async () => {
    const empty = (await buildReview(context(true))).quality!;
    expect(Object.values(empty.scores).every(score => score.value === null)).toBe(true);
    const ctx = context(); ctx.domains = [];
    const missing = (await buildReview(ctx)).quality!;
    expect(missing.scores.dependencySimplicity.value).not.toBeNull();
    expect(missing.scores.domainCoverage).toMatchObject({ value: null, unavailableReason: "no detected domains" });
  });

  it("caps opportunities without changing totals or treating no call evidence as low cohesion", async () => {
    const domains = await buildDomainReview(context());
    const all = findRefactoringOpportunities(domains);
    const capped = findRefactoringOpportunities(domains, 1);
    expect(capped.total).toBe(all.total);
    expect(capped.items).toEqual(all.items.slice(0, 1));
    domains.domains.forEach(d => { d.cohesion = null; });
    expect(findRefactoringOpportunities(domains).items.some(i => i.kind === "low-cohesion")).toBe(false);
  });

  it("does not subtract non-function overlaps from the function population", async () => {
    const domains = await buildDomainReview(context());
    domains.summary.overlap = 99;
    const scores = buildQualityScores([{ anchor: "a" as AnchorId, domainOverlap: 1,
      sharedStateFanIn: 0, crossDomainDepth: 0, cyclomatic: 1, fanIn: 0, fanOut: 0, coupling: 0 }], domains);
    expect(scores.domainSeparation).toMatchObject({ value: 100, numerator: 1, denominator: 1 });
  });
});
