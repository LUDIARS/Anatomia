/**
 * T29 — Verify gates barrel.
 */
export type { Gate, DiffInput, DuplicationDeps } from "./types.js";
export { changedAnchors, isTestFilePath, productionChanged } from "./types.js";
export { ruleConformanceGate } from "./rule_conformance.js";
export { duplicationGate } from "./duplication.js";
export { specLinkageGate } from "./spec_linkage.js";
export { couplingDeltaGate } from "./coupling_delta.js";
export { conventionDriftGate } from "./convention_drift.js";
export { PLAN_CONFORMANCE_GATE, planConformanceGate } from "./plan_conformance.js";
