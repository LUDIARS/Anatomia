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
export { buildDomainReview } from "./domain-review.js";
export type {
  DomainReviewReport,
  DomainReviewEntry,
  DomainReviewOptions,
  DomainOverlap,
  SpecIntegrityWarning,
  DomainDefWithSpecs,
} from "./domain-review.js";
export { formatDomainReview } from "./domain-review-format.js";
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
