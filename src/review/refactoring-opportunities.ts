/**
 * Evidence-based domain review prompts; no mutations.
 * @spec Code quality from analysis
 */
import type { DomainReviewReport } from "./domain-review.js";
import type { ReviewLocation } from "./build.js";

export interface RefactoringOpportunity {
  kind: "low-cohesion" | "isolated-members" | "boundary-drift" | "overlapping-ownership" | "missing-ownership";
  domain: string | null;
  count: number;
  evidence: string;
  action: string;
  locations: ReviewLocation[];
}

const LOW_COHESION = 0.5;
const MAX_EXAMPLES = 5;

export function findRefactoringOpportunities(report: DomainReviewReport, limit = 50): {
  total: number; items: RefactoringOpportunity[];
} {
  const items: RefactoringOpportunity[] = [];
  for (const d of report.domains) {
    if (d.cohesion !== null && d.cohesion < LOW_COHESION) {
      items.push({ kind: "low-cohesion", domain: d.domain, count: d.boundaryEdges,
        evidence: `internal=${d.internalEdges}, boundary=${d.boundaryEdges}; cohesion < ${LOW_COHESION}`,
        action: "Review boundary responsibilities and dependency direction; shared infrastructure may legitimately cross boundaries.", locations: [] });
    }
    if (d.isolatedCount > 0) {
      items.push({ kind: "isolated-members", domain: d.domain, count: d.isolatedCount,
        evidence: "Members have no observed calls to another member of this domain.",
        action: "Check membership and indirect/event-driven calls before moving code.", locations: d.isolated.slice(0, MAX_EXAMPLES) });
    }
  }
  // Grouped counts use uncapped summaries; examples can be incomplete.
  if (report.summary.boundaryDrift > 0) items.push({ kind: "boundary-drift", domain: null,
    count: report.summary.boundaryDrift,
    evidence: report.boundaryDrift.slice(0, MAX_EXAMPLES).map(d => `${d.name}: ${d.domain} -> ${d.suggested}`).join("; "),
    action: "Compare call-neighbourhood suggestions with approved business ownership; do not reassign automatically.",
    locations: report.boundaryDrift.slice(0, MAX_EXAMPLES) });
  if (report.summary.overlap > 0) items.push({ kind: "overlapping-ownership", domain: null,
    count: report.summary.overlap, evidence: "Code members are claimed by multiple domains.",
    action: "Clarify the owning responsibility or document intentional shared membership.", locations: report.overlap.slice(0, MAX_EXAMPLES) });
  if (report.summary.unassigned > 0) items.push({ kind: "missing-ownership", domain: null,
    count: report.summary.unassigned, evidence: "Functions have no detected domain membership.",
    action: "Review declarations and source coverage before proposing new ownership.", locations: report.unassigned.slice(0, MAX_EXAMPLES) });
  items.sort((a, b) => b.count - a.count || compare(a.kind, b.kind) || compare(a.domain ?? "", b.domain ?? ""));
  return { total: items.length, items: items.slice(0, Math.max(0, Math.floor(limit))) };
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
