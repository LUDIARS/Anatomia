/**
 * src/integral/cache.ts — Phase C: the integral path cache.
 *
 * The design notes that investigation-type queries recur AFTER the LLM's own
 * prompt cache has expired, so the graph paths an agent explored (and the
 * scope it judged) must be cached as RESULTS. This is that store: a content-
 * addressed CacheStore keyed by (search content key + project fingerprint +
 * model + prompt version). A repeat investigation replays the cached report
 * without re-invoking Sonnet. Because the key folds the project fingerprint, any
 * source edit (which changes the fingerprint and the seed anchors' hashes)
 * naturally invalidates the entry — the same Merkle-invalidation the rest of
 * Anatomia relies on.
 *
 * SRP: key construction + store typing only. Search is search.ts, the judge is
 * agent.ts, orchestration is run.ts.
 */

import { createMemoryStore, versionedKey, type CacheStore } from "../cache/store.js";
import type { IntegralResult, ScopeDecision } from "./types.js";

/** The cached unit: the Phase-A result + the Phase-B judgement. */
export interface CachedIntegral {
  result: IntegralResult;
  decision: ScopeDecision;
}

/** Content-addressed integral path cache (memory default, file/redis via resolve). */
export type IntegralCache = CacheStore<CachedIntegral>;

/** Create an empty in-memory path cache (the hermetic default). */
export function createIntegralCache(): IntegralCache {
  return createMemoryStore<CachedIntegral>();
}

/**
 * Build the cache key for an integral report.
 *
 * `contentKey` (from the search) already folds the seed anchors + range. We fold
 * the project fingerprint so a changed source tree never serves a stale path, and
 * the model id + prompt version so a different judge model/prompt stays distinct.
 */
export function integralCacheKey(
  contentKey: string,
  fingerprint: string,
  modelId: string,
  promptVersion: string,
): string {
  return versionedKey(`${contentKey}:${fingerprint}`, modelId, promptVersion);
}
