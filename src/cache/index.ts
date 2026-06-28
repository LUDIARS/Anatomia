/**
 * cache/ — Shared content-addressed LLM cache (A-3, DESIGN §4.4 / §9).
 *
 *   store.ts        — CacheStore<V> interface, in-memory impl, versionedKey
 *   file-store.ts   — persistent one-file-per-key store (cross-process sharing)
 *   transcript.ts   — append-only JSONL event log (hit/miss/llm) for measurement
 *   instrumented.ts — CacheStore decorator that records hit/miss
 *   stats.ts        — aggregate a transcript into a hit-rate report
 */
export type { CacheStore } from "./store.js";
export { createMemoryStore, versionedKey } from "./store.js";
export type { Embedder, CachedVector } from "./embedding.js";
export { createCachedEmbedder, sharedEmbeddingCache, EMBED_CACHE_VERSION } from "./embedding.js";
export { createFileStore } from "./file-store.js";
export type { RedisLike, RedisStoreOptions } from "./redis-store.js";
export { createRedisStore } from "./redis-store.js";
export { resolveCacheStore, describeCacheBackend } from "./resolve.js";
export type { CacheEvent, GetEvent, LlmEvent, LlmUsage, CacheTranscript } from "./transcript.js";
export {
  createNullTranscript,
  createJsonlTranscript,
  resolveTranscript,
  resolveSessionId,
  readEvents,
} from "./transcript.js";
export type { CacheCounters, InstrumentOptions } from "./instrumented.js";
export { instrumentStore, createCounters, hitRate } from "./instrumented.js";
export type { CacheStatsReport, HitTally } from "./stats.js";
export { aggregate, formatReport } from "./stats.js";
export { runWithSession, currentSession } from "./session-context.js";
export type { CostEstimate, ModelPricing, AssumedCallSize } from "./cost-estimate.js";
export { estimateCost, resolveCostParams } from "./cost-estimate.js";
