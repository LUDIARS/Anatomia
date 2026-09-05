import type { RevisionEvidence } from "../types.js";

export interface DomainBoundary {
  inScope: string[];
  outOfScope: string[];
}

export interface DomainProposal {
  proposalId: string;
  candidateId: string;
  name: string;
  purpose: string;
  responsibilities: string[];
  boundary: DomainBoundary;
  assignable: boolean;
  /** Human-authored UX criticality; absent leaves screen evidence to decide. */
  uxCritical?: boolean;
  sourceClauseIds: string[];
  sourceRevision: string;
  analysisSnapshotId: string;
  expectedHead: string | null;
  /** Expected bytes hash for an existing authored domain OKF; null means create-only. */
  expectedDomainContentHash: string | null;
  parentCandidateId: string | null;
  assumptions: string[];
  unresolvedQuestions: string[];
  evidence: {
    deterministic: Array<{ clauseId: string; reason: string }>;
    llm: Array<{ field: string; value: string; confidence: number }>;
    human: Array<{ field: string; value: string; reviewRef: string }>;
  };
}

export interface DomainHierarchyEdge {
  childId: string;
  parentId: string;
}

export interface ApprovedDomain {
  id: string;
  name: string;
  purpose: string;
  responsibilities: string[];
  boundary: DomainBoundary;
  assignable: boolean;
  /** Human-authored UX criticality; absent leaves screen evidence to decide. */
  uxCritical?: boolean;
  aliases: string[];
  revision: RevisionEvidence;
}

export type AssignmentActionKind = "assign-existing" | "move" | "unassign" | "abstain";
export type AssignmentEvidenceKind =
  | "explicit-annotation"
  | "ratified-spec-link"
  | "signature"
  | "call-neighborhood"
  | "path-pattern"
  | "name-pattern"
  | "negative-boundary";

export interface CodeSymbolEvidence {
  symbolId: string;
  language: string;
  qualifiedName: string;
  sourcePath: string;
  startLine: number;
  endLine: number;
  signature: string;
  signatureShape: string;
  sourceRevision: string;
  contentFingerprint: string;
}

export interface DomainAssignmentCandidate {
  domainId: string;
  evidence: Array<{
    kind: AssignmentEvidenceKind;
    detail: string;
    confidence: number;
    sourceAnchor?: string;
  }>;
}

export interface DomainAssignmentAction {
  proposalId: string;
  action: AssignmentActionKind;
  symbol: CodeSymbolEvidence;
  beforeOwner: string | null;
  afterOwner: string | null;
  relatedDomainIds: string[];
  confidence: number;
  positiveEvidence: DomainAssignmentCandidate["evidence"];
  negativeEvidence: DomainAssignmentCandidate["evidence"];
  rationale: string;
  analysisSnapshotId: string;
  expectedHead: string | null;
}

export type DomainDriftKind =
  | "aligned"
  | "spec-only"
  | "code-only"
  | "wrong-membership"
  | "overlap"
  | "boundary-drift"
  | "stale-spec-link"
  | "contradiction"
  | "hierarchy-invalid";

export interface DomainDriftFinding {
  kind: DomainDriftKind;
  domainIds: string[];
  symbolIds: string[];
  clauseIds: string[];
  evidence: string[];
  disposition: "gate-a" | "gate-b" | "gate-c" | "none";
}

export interface SemanticDomainProposal {
  proposalId: string;
  kind: "split" | "merge" | "boundary" | "hierarchy";
  affectedDomainIds: string[];
  affectedSymbolIds: string[];
  affectedClauseIds: string[];
  evidence: string[];
  unresolvedQuestions: string[];
  sourceRevision: string;
  analysisSnapshotId: string;
  expectedHead: string | null;
  requiresGate: "gate-c";
}

export interface CodeGapProposal {
  proposalId: string;
  kind: "emergent-domain" | "spec-gap";
  symbolIds: string[];
  sourceAnchors: string[];
  cohesion: number;
  coupling: number;
  existingDomainCandidates: Array<{ domainId: string; supporting: string[]; counterEvidence: string[] }>;
  provisionalPurpose: string;
  provisionalBoundary: DomainBoundary;
  requiredSpecDraft: string;
  unresolvedQuestions: string[];
  requiresGate: "gate-a";
}
