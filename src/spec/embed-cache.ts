/**
 * src/spec/embed-cache.ts — content-keyed embedding cache for spec linking.
 *
 * The semantic linker embeds every clause text + code summary on each run;
 * with a networked embedder that is a round-trip per analysis even though the
 * texts barely change. Wrapping the injected EmbeddingClient with a per-text
 * content-key cache (sha256(text) + embedder version id, see
 * cache/embedding.ts) makes re-analysis embed only what actually changed —
 * and keeps the linker deterministic: the same text under the same embedder
 * id always yields the same vector, cached or fresh.
 *
 * This module DELEGATES to cache/embedding.ts's createCachedEmbedder (the
 * duplication gate's decorator — EmbeddingClient and Embedder are the same
 * `(texts) => Promise<number[][]>` shape) rather than re-implementing the
 * keying; it exists so the spec layer names its own seam and never imports
 * the gate's cache module from call sites.
 *
 * SRP: cache adaptation for the semantic linker only. Similarity math stays
 * in semantic.ts; key derivation in cache/embedding.ts.
 */

import { createCachedEmbedder } from "../cache/embedding.js";
import type { CachedVector } from "../cache/embedding.js";
import type { CacheStore } from "../cache/store.js";
import type { EmbeddingClient } from "./semantic.js";

export type { CachedVector } from "../cache/embedding.js";

/**
 * Wrap `inner` with a per-text content-key cache. `embedderId` must identify
 * the embedding model/version (e.g. Providers.embedModelId) so a swapped
 * embedder never serves stale vectors.
 */
export function cachedEmbeddingClient(
  inner: EmbeddingClient,
  cache: CacheStore<CachedVector>,
  embedderId: string,
): EmbeddingClient {
  return createCachedEmbedder(inner, cache, embedderId);
}
