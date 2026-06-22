/**
 * src/integral/index.ts — Integral-search public surface.
 *
 * Integral search compiles the "初回の必要点まとめ" for a task: from an entry
 * point it climbs 構造グラフ → ドメイン → シーンステート within an exploration
 * range, deterministically (≤10s), then optionally hands the bundle to a Sonnet
 * agent that judges how far is enough and caches the explored path.
 */

export type {
  IntegralScope,
  IntegralGraphHint,
  IntegralRange,
  IntegralQuery,
  IntegralAnchor,
  IntegralModule,
  IntegralDomain,
  IntegralScene,
  IntegralResult,
  ScopeDecision,
  IntegralReport,
} from "./types.js";
export { integralSearch, integralContentKey, type IntegralContext } from "./search.js";
export { judgeScope, assembleJudgePrompt, parseScopeDecision, JUDGE_PROMPT_VERSION } from "./agent.js";
export { runIntegral, type RunIntegralOptions } from "./run.js";
export {
  createIntegralCache,
  integralCacheKey,
  type IntegralCache,
  type CachedIntegral,
} from "./cache.js";
export {
  createSceneModel,
  emptySceneModel,
  scenesFromPhaseSignatures,
  type SceneModel,
  type SceneRef,
} from "./scene.js";
export { resolveSeeds, type ResolveInputs } from "./resolve.js";
