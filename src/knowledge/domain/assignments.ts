import { createHash } from "node:crypto";
import type {
  CodeSymbolEvidence,
  DomainAssignmentAction,
  DomainAssignmentCandidate,
} from "./types.js";

const AUTHORITATIVE = new Set(["explicit-annotation", "ratified-spec-link"]);

function actionId(symbolId: string, snapshot: string): string {
  const hash = createHash("sha256").update(`${symbolId}\n${snapshot}`, "utf8").digest("hex").slice(0, 20);
  return `proposal:assignment/${hash}`;
}

function score(candidate: DomainAssignmentCandidate): number {
  const positives = candidate.evidence.filter((item) => item.kind !== "negative-boundary");
  const negatives = candidate.evidence.filter((item) => item.kind === "negative-boundary");
  return positives.reduce((sum, item) => sum + item.confidence, 0)
    - negatives.reduce((sum, item) => sum + item.confidence, 0);
}

export function analyzeCodeAssignment(
  symbol: CodeSymbolEvidence,
  candidates: DomainAssignmentCandidate[],
  beforeOwner: string | null,
  analysisSnapshotId: string,
  expectedHead: string | null,
): DomainAssignmentAction {
  const ordered = [...candidates].sort((left, right) => score(right) - score(left)
    || left.domainId.localeCompare(right.domainId));
  const best = ordered[0];
  const authoritative = best?.evidence.some((item) => AUTHORITATIVE.has(item.kind)) ?? false;
  const tied = best !== undefined && ordered[1] !== undefined && Math.abs(score(best) - score(ordered[1])) < 0.1;
  const afterOwner = authoritative && !tied && score(best) >= 0.75 ? best.domainId : null;
  let action: DomainAssignmentAction["action"] = "abstain";
  if (afterOwner && beforeOwner === null) action = "assign-existing";
  else if (afterOwner && beforeOwner !== afterOwner) action = "move";
  else if (!afterOwner && beforeOwner && best?.evidence.every((item) => item.kind === "negative-boundary")) action = "unassign";

  const selected = best?.evidence ?? [];
  return {
    proposalId: actionId(symbol.symbolId, analysisSnapshotId),
    action,
    symbol,
    beforeOwner,
    afterOwner: action === "unassign" ? null : afterOwner ?? beforeOwner,
    relatedDomainIds: ordered.slice(1).filter((candidate) => score(candidate) > 0.4).map((candidate) => candidate.domainId),
    confidence: best ? Math.max(0, Math.min(1, score(best))) : 0,
    positiveEvidence: selected.filter((item) => item.kind !== "negative-boundary"),
    negativeEvidence: selected.filter((item) => item.kind === "negative-boundary"),
    rationale: action === "abstain"
      ? "No unique authoritative evidence supports an ownership change."
      : `${action} is supported by exact symbol evidence at ${symbol.sourcePath}:${symbol.startLine}.`,
    analysisSnapshotId,
    expectedHead,
  };
}
