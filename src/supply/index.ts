/**
 * supply/ — Supply/verify loop (G5, DESIGN §9.1).
 *
 *   T26 metrics.ts    — game-aware complexity metrics
 *   T26 thresholds.ts — codebase-relative thresholds (repo's own distribution)
 *   T27 landing.ts    — landing-point decision (domain × layer × siblings)
 *   T28 bundle.ts     — deterministic, content-addressed context bundle
 *   T29 verify.ts     — 5 gates -> Verdict (gates/ sub-folder)
 */

// T26 — metrics + thresholds
export { computeMetrics, METRIC_KEYS } from "./metrics.js";
export type { NodeMetrics, MetricKey, DomainMembership } from "./metrics.js";
export { deriveThresholds, percentile, isFlagged } from "./thresholds.js";
export type { Thresholds, MetricThreshold, DeriveOptions } from "./thresholds.js";

// T27 — landing
export { resolveLanding } from "./landing.js";
export type {
  LandingTask,
  DomainDetector,
  LayerRules,
  Sibling,
  SiblingLookup,
  Landing,
} from "./landing.js";
export {
  contextDomainDetector,
  contextLayerRules,
  contextSiblingLookup,
  landingInjections,
} from "./detectors.js";

// T28 — bundle
export {
  assembleBundle,
  bundleContentKey,
  orderBundleSegments,
} from "./bundle.js";
export type { BundleInputs, AddressedBundle, BundleSegment } from "./bundle.js";
export {
  RELEVANCE_VERSION,
  rankSpecClauses,
  rankExemplars,
  tokenizeRelevanceText,
} from "./relevance.js";
export type { RelevanceOptions } from "./relevance.js";

// T29 — verify + gates
export { verify, buildDefaultGates } from "./verify.js";
export { membershipOf, verifyThresholds, selectSiblings } from "./verify-inputs.js";
export type { VerifyOptions } from "./verify.js";
export {
  changedAnchors,
  ruleConformanceGate,
  duplicationGate,
  specLinkageGate,
  couplingDeltaGate,
  conventionDriftGate,
} from "./gates/index.js";
export type { Gate, DiffInput, DuplicationDeps } from "./gates/index.js";
