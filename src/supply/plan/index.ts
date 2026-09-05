/**
 * supply/plan/ — `anatomia plan`: task → domain-sized work plan (design §3).
 *
 *   collect.ts            candidates (declared domains × analysis)
 *   decompose-llm.ts      task → pieces (LLM, pinned model, deadline)
 *   decompose-fallback.ts task → pieces (deterministic detector)
 *   data-defs.ts          what each target domain already defines
 *   duplicates.ts         what already exists with the same vocabulary
 *   exemplar.ts           the implementation to imitate
 *   build.ts              the pipeline
 *   format.ts             Markdown rendering
 *   format-okf.ts         OKF rendering (for delegation prompts)
 *   store.ts              `.anatomia/plan/<hash>.json`
 *   conformance.ts        plan ↔ changed files (verify --plan)
 *
 * @spec パイプライン（`src/supply/plan/`）
 */

export { buildPlan } from "./build.js";
export type { BuildPlanOptions } from "./build.js";
export { collectAllCandidates, collectCandidates, repoRelative } from "./collect.js";
export type { PlanRepo } from "./collect.js";
export { decomposeDeterministically } from "./decompose-fallback.js";
export type { Decomposition, DecomposedItem } from "./decompose-fallback.js";
export {
  PLAN_LLM_TIMEOUT_MS,
  PLAN_MODEL,
  buildDecomposePrompt,
  decomposeWithLlm,
  parseDecomposition,
} from "./decompose-llm.js";
export type { LlmDecomposeOptions } from "./decompose-llm.js";
export { collectDataDefs, domainFiles } from "./data-defs.js";
export { findDuplicates } from "./duplicates.js";
export { domainLayer, findExemplar } from "./exemplar.js";
export { formatPlan } from "./format.js";
export { formatPlanOkf } from "./format-okf.js";
export {
  PLAN_DIR_REL,
  latestPlanFile,
  loadPlan,
  planFilePath,
  planHash,
  savePlan,
} from "./store.js";
export { evaluatePlanConformance } from "./conformance.js";
export type { PlanConformance } from "./conformance.js";
export { PLAN_VERSION } from "./types.js";
export type {
  Plan,
  PlanDataDef,
  PlanDomainCandidate,
  PlanDuplicate,
  PlanExemplar,
  PlanItem,
  PlanNewDomain,
  PlanSource,
  PlanUnresolved,
} from "./types.js";

export { hasKnowledgeLog, knowledgeLogPathFor, resolveUxCriticalDomainNames } from "./ux-critical-bridge.js";
export { buildPlanLayerWarnings, itemLayer } from "./layer-warnings.js";
