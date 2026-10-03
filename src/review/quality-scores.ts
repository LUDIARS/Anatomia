/**
 * Descriptive scores, never an AI success estimate.
 * @spec Code quality from analysis
 */
import type { NodeMetrics } from "../supply/metrics.js";
import type { DomainReviewReport } from "./domain-review.js";

export interface QualityScore {
  value: number | null;
  formula: string;
  numerator: number;
  denominator: number;
  unavailableReason: string | null;
}

export interface QualityScores {
  dependencySimplicity: QualityScore;
  domainCoverage: QualityScore;
  domainSeparation: QualityScore;
  domainCohesion: QualityScore;
}

function ratio(numerator: number, denominator: number, formula: string, reason?: string): QualityScore {
  return {
    value: reason || denominator === 0 ? null : Math.round(10000 * numerator / denominator) / 100,
    numerator, denominator, formula,
    unavailableReason: reason ?? (denominator === 0 ? "no observations" : null),
  };
}

/** Input metrics must contain only function/method nodes in the declared population. */
export function buildQualityScores(metrics: readonly NodeMetrics[], domains: DomainReviewReport): QualityScores {
  const calls = metrics.reduce((sum, m) => sum + Math.max(0, m.cyclomatic - 1), 0);
  const domainReason = domains.summary.domains === 0 ? "no detected domains" : undefined;
  // Domain-review overlap also includes non-function implementors. Keep this
  // score's numerator in the same function population as its denominator.
  const assigned = metrics.filter(m => m.domainOverlap > 0).length;
  const overlapping = metrics.filter(m => m.domainOverlap > 1).length;
  const internal = domains.domains.reduce((sum, d) => sum + d.internalEdges, 0);
  const boundary = domains.domains.reduce((sum, d) => sum + d.boundaryEdges, 0);
  return {
    dependencySimplicity: ratio(4 * metrics.length, 4 * metrics.length + calls,
      "100 / (1 + mean call-out-degree / 4)"),
    domainCoverage: ratio(domains.summary.assigned, domains.summary.functions,
      "100 * assigned functions / functions", domainReason),
    domainSeparation: ratio(assigned - overlapping, assigned,
      "100 * (assigned - overlapping) / assigned", domainReason),
    domainCohesion: ratio(internal, internal + boundary,
      "100 * sum(internal domain edges) / sum(internal + boundary domain edges)", domainReason),
  };
}
