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
