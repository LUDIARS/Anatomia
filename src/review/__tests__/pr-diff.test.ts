import { describe, expect, it } from "vitest";
import { summarizeComplexity } from "../pr-diff.js";
import type { NodeMetrics } from "../../supply/metrics.js";
import type { AnchorId } from "../../types.js";

function metric(anchor: string, cyclomatic: number): NodeMetrics {
  return {
    anchor: anchor as AnchorId,
    cyclomatic,
    domainOverlap: 0,
    sharedStateFanIn: 0,
    crossDomainDepth: 0,
    fanIn: 0,
    fanOut: Math.max(0, cyclomatic - 1),
    coupling: Math.max(0, cyclomatic - 1),
  };
}

describe("summarizeComplexity", () => {
  it("returns a stable 0..100 score whose value falls as complexity rises", () => {
    expect(summarizeComplexity([])).toEqual({
      functions: 0,
      averageCyclomatic: 0,
      maximumCyclomatic: 0,
      score: 100,
    });
    const simple = summarizeComplexity([metric("a", 1), metric("b", 1)]);
    const complex = summarizeComplexity([metric("a", 5), metric("b", 5)]);
    expect(simple.score).toBe(100);
    expect(complex.score).toBe(50);
    expect(complex.averageCyclomatic).toBe(5);
    expect(complex.maximumCyclomatic).toBe(5);
  });
});
