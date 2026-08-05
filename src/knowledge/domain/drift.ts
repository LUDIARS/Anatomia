import { createHash } from "node:crypto";
import type { DomainDriftFinding, SemanticDomainProposal } from "./types.js";

export interface DomainDriftInput {
  domainId: string;
  clauseIds: string[];
  symbolIds: string[];
  expectedSymbolIds: string[];
  staleClauseIds?: string[];
  hierarchyValid?: boolean;
  contradictsBoundary?: boolean;
  overlapDomainIds?: string[];
  boundaryDriftEvidence?: string[];
}

export function classifyDomainDrift(input: DomainDriftInput): DomainDriftFinding[] {
  const findings: DomainDriftFinding[] = [];
  if (input.hierarchyValid === false) {
    findings.push({ kind: "hierarchy-invalid", domainIds: [input.domainId], symbolIds: [], clauseIds: [], evidence: ["hierarchy validation failed"], disposition: "gate-c" });
  }
  if (input.staleClauseIds?.length) {
    findings.push({ kind: "stale-spec-link", domainIds: [input.domainId], symbolIds: [], clauseIds: input.staleClauseIds, evidence: ["linked clause revision is stale"], disposition: "gate-b" });
  }
  if (input.contradictsBoundary) {
    findings.push({ kind: "contradiction", domainIds: [input.domainId], symbolIds: input.symbolIds, clauseIds: input.clauseIds, evidence: ["implementation contradicts approved boundary"], disposition: "gate-c" });
  }
  if ((input.overlapDomainIds?.length ?? 0) > 0) {
    findings.push({
      kind: "overlap",
      domainIds: [...new Set([input.domainId, ...input.overlapDomainIds!])].sort(),
      symbolIds: input.symbolIds,
      clauseIds: input.clauseIds,
      evidence: ["the same responsibility is claimed by multiple semantic domains"],
      disposition: "gate-c",
    });
  }
  if ((input.boundaryDriftEvidence?.length ?? 0) > 0) {
    findings.push({
      kind: "boundary-drift",
      domainIds: [input.domainId],
      symbolIds: input.symbolIds,
      clauseIds: input.clauseIds,
      evidence: [...input.boundaryDriftEvidence!],
      disposition: "gate-c",
    });
  }
  if (input.clauseIds.length > 0 && input.symbolIds.length === 0) {
    findings.push({ kind: "spec-only", domainIds: [input.domainId], symbolIds: [], clauseIds: input.clauseIds, evidence: ["approved specification has no implementor"], disposition: "none" });
  } else if (input.clauseIds.length === 0 && input.symbolIds.length > 0) {
    findings.push({ kind: "code-only", domainIds: [input.domainId], symbolIds: input.symbolIds, clauseIds: [], evidence: ["implementation has no approved specification"], disposition: "gate-a" });
  }
  const unexpected = input.symbolIds.filter((id) => !input.expectedSymbolIds.includes(id));
  if (unexpected.length > 0) {
    findings.push({ kind: "wrong-membership", domainIds: [input.domainId], symbolIds: unexpected, clauseIds: input.clauseIds, evidence: ["owner differs from approved assignment evidence"], disposition: "gate-b" });
  }
  if (findings.length === 0) {
    findings.push({ kind: "aligned", domainIds: [input.domainId], symbolIds: input.symbolIds, clauseIds: input.clauseIds, evidence: ["specification and assignments agree"], disposition: "none" });
  }
  return findings;
}

export interface SemanticProposalContext {
  sourceRevision: string;
  analysisSnapshotId: string;
  expectedHead: string | null;
}

/** Converts semantic drift into reviewable split/merge proposals; it never approves them. */
export function proposeSemanticDomainChanges(
  findings: DomainDriftFinding[],
  context: SemanticProposalContext,
): SemanticDomainProposal[] {
  return findings
    .filter((finding) => finding.kind === "overlap" || finding.kind === "boundary-drift")
    .map((finding) => {
      const kind = finding.kind === "overlap" ? "merge" as const : "split" as const;
      const fingerprint = JSON.stringify({
        kind,
        domainIds: [...finding.domainIds].sort(),
        symbolIds: [...finding.symbolIds].sort(),
        clauseIds: [...finding.clauseIds].sort(),
        snapshot: context.analysisSnapshotId,
      });
      const digest = createHash("sha256").update(fingerprint, "utf8").digest("hex").slice(0, 20);
      return {
        proposalId: `proposal:domain-${kind}/${digest}`,
        kind,
        affectedDomainIds: [...finding.domainIds].sort(),
        affectedSymbolIds: [...finding.symbolIds].sort(),
        affectedClauseIds: [...finding.clauseIds].sort(),
        evidence: [...finding.evidence],
        unresolvedQuestions: kind === "merge"
          ? ["Should these responsibilities share one approved boundary?"]
          : ["Which authored responsibility defines each resulting boundary?"],
        ...context,
        requiresGate: "gate-c" as const,
      };
    })
    .sort((left, right) => left.proposalId.localeCompare(right.proposalId));
}
