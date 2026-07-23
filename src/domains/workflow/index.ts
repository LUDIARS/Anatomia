export type {
  GeneratedDomainSpecDraft,
  OrphanDomainProposal,
  OrphanProposalCache,
} from "./orphan-proposals.js";
export {
  ORPHAN_PROPOSAL_PROMPT_VERSION,
  assembleOrphanProposalPrompt,
  membershipPatterns,
  orphanSpecSnapshotId,
  synthesizeOrphanDomainProposals,
} from "./orphan-proposals.js";
export type { ApprovedOrphanDomainProposal } from "./spec-store.js";
export {
  approvedDomainSpecRelativePath,
  renderApprovedDomainSpec,
  saveApprovedDomainSpecs,
} from "./spec-store.js";
export type {
  ApprovedOrphanApplyResult,
  ApprovedOrphanGateApplyResult,
  ApproveOrphanDomainInput,
  CurrentOrphanApprovalEvidence,
  GateBApprovalPersistence,
} from "./apply-approved.js";
export {
  approveAndApplyOrphanDomains,
  OrphanApprovalConflictError,
  orphanProposalToEditableDef,
} from "./apply-approved.js";
export type { DomainDiscoveryGateState } from "./gate-state.js";
export {
  DomainDiscoveryGateError,
  domainDiscoveryGatePath,
  editableDomainsSnapshotId,
  requireGateAApproval,
  saveGateAApproval,
} from "./gate-state.js";
export type {
  ApplyGateAApprovalInput,
  ApplyGateAApprovalResult,
  GateAApprovalPersistence,
  GateAReconcileSummary,
} from "./gate-a-approval.js";
export {
  GateAApprovalConflictError,
  GateAOverrideRequiredError,
  applyGateAApproval,
} from "./gate-a-approval.js";
