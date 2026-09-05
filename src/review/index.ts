/**
 * review/ — deterministic structural review assembled from rules × domain graph
 * × AST graph (+ spec links). No LLM. See build.ts.
 */

export { buildReview } from "./build.js";
export type {
  ReviewReport,
  ReviewLocation,
  ReviewViolation,
  ReviewHotspot,
  ReviewDup,
  ReviewDomainCoupling,
  ReviewOptions,
} from "./build.js";
export { formatReview } from "./format.js";
export { buildRefactoringProposals, refactoringProposalId } from "./refactoring-proposals.js";
export type { RefactoringAction, RefactoringLocation, RefactoringProposal, RefactoringSignal, RefactoringSignalRule } from "./refactoring-proposals.js";
export { buildDomainReview } from "./domain-review.js";
export { buildDomainReviewByLayer, UNCLASSIFIED_LAYER } from "./domain-review-by-layer.js";
export type { DomainReviewByLayerReport, LayerReviewEntry } from "./domain-review-by-layer.js";
export type {
  DomainReviewReport,
  DomainReviewEntry,
  DomainReviewOptions,
  DomainOverlap,
  SpecIntegrityWarning,
  DomainDefWithSpecs,
  BoundaryDriftFinding,
} from "./domain-review.js";
export { formatDomainReview, formatDomainReviewByLayer } from "./domain-review-format.js";
export { buildPrDiffReview, summarizeComplexity } from "./pr-diff.js";
export type {
  PrDiffReview,
  PrDiffReviewOptions,
  PrTargetDomain,
  PrComplexitySummary,
} from "./pr-diff.js";
export { detectBoundaryDrift } from "./boundary.js";
export type { BoundaryDrift, DriftVote, BoundaryDriftOptions } from "./boundary.js";
export {
  loadBaseline,
  saveBaseline,
  applyBaseline,
  fingerprintViolation,
  fingerprintDup,
  fingerprintCycle,
  fingerprintCoupling,
} from "./baseline.js";
export type { ReviewBaseline } from "./baseline.js";
