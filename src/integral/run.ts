/**
 * src/integral/run.ts — Orchestrate the three integral phases.
 *
 *   Phase A  integralSearch()  — deterministic necessity bundle (≤10s, no LLM)
 *   Phase B  judgeScope()      — Sonnet judges how far is enough (optional)
 *   Phase C  path cache        — replay a prior judged report, skipping Sonnet
 *
 * The path cache is consulted ONLY when a judge is requested (Phase A is cheap +
 * deterministic, so caching it saves nothing; the Sonnet call is the cost worth
 * saving). On a cache hit the cached report is returned with `cached: true` and
 * the LLM is never called.
 *
 * SRP: phase wiring only. Each phase lives in its own module.
 */

import type { LLMClient } from "../domains/card.js";
import type { ModuleEvaluation } from "../modules/types.js";
import { integralSearch, type IntegralContext } from "./search.js";
import { judgeScope, JUDGE_PROMPT_VERSION } from "./agent.js";
import { createIntegralCache, integralCacheKey, type IntegralCache } from "./cache.js";
import { emptySceneModel, type SceneModel } from "./scene.js";
import type { IntegralQuery, IntegralReport } from "./types.js";

export interface RunIntegralOptions {
  /** Scene model (dynamic layer). Default: empty (structure+domain only). */
  scenes?: SceneModel;
  /**
   * Injected judge LLM (Sonnet). Required to run Phase B; when omitted only the
   * deterministic Phase-A bundle is returned (decision = null).
   */
  llm?: LLMClient;
  /** Resolved judge model id, folded into the path-cache key. Default "default". */
  modelId?: string;
  /**
   * Project fingerprint, folded into the path-cache key so a source edit
   * invalidates cached paths. Default "nofp" (legacy single-context callers).
   */
  fingerprint?: string;
  /** Reused path cache (content-keyed). Default: a fresh in-memory store. */
  cache?: IntegralCache;
  /** Analyze-time module evaluation (機能 layer + cohesion). Enables the module climb + cohesion. */
  moduleEval?: ModuleEvaluation;
}

/**
 * Run integral search and (optionally) the Sonnet scope judge, with path caching.
 */
export async function runIntegral(
  ctx: IntegralContext,
  query: IntegralQuery,
  opts: RunIntegralOptions = {},
): Promise<IntegralReport> {
  const scenes = opts.scenes ?? emptySceneModel();
  const result = await integralSearch(ctx, query, scenes, opts.moduleEval);

  // No judge requested → return the deterministic bundle alone.
  if (!opts.llm) {
    return { result, decision: null, cached: false };
  }

  const cache = opts.cache ?? createIntegralCache();
  const key = integralCacheKey(
    result.contentKey,
    opts.fingerprint ?? "nofp",
    opts.modelId ?? "default",
    JUDGE_PROMPT_VERSION,
  );

  const hit = await cache.get(key);
  if (hit) {
    // Replay the cached judgement; the freshly-computed result is identical
    // (the key folds the fingerprint), so use it to reflect the current graph.
    return { result, decision: hit.decision, cached: true };
  }

  const decision = await judgeScope(query, result, opts.llm);
  await cache.set(key, { result, decision });
  return { result, decision, cached: false };
}
