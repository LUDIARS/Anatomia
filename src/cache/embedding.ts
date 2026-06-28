/**
 * src/cache/embedding.ts — content-addressed embedding cache.
 *
 * The duplication gate embeds the changed code + each existing domain card to
 * measure reinvention (supply/gates/duplication.ts → embed([newText, ...cards])).
 * With a real OpenAI-compatible embedder (ANATOMIA_EMBED_BASE_URL) that is a
 * network round-trip per verify, and the card texts barely change between
 * verifies — so re-embedding the same card texts every time is wasted cost and
 * latency. (The default hash embedder is local + deterministic, so caching it
 * just trades a little memory for a little CPU — harmless; the real win is a
 * networked embedder.)
 *
 * Caching is PER TEXT, not per batch: each text is keyed independently, so when
 * only the changed code differs between two verifies the stable card vectors are
 * all reused and just the one new text is embedded. Keying per text also keeps
 * the returned vectors aligned to the input order (a batch-level key would have
 * to fix an order, and a reordered batch would misalign).
 *
 * Key = versionedKey(sha256(text), embedModelId, EMBED_CACHE_VERSION): a
 * different embed model or a changed text never serves a stale vector.
 *
 * SRP: caching decorator over an embedder only.
 */

import { createHash } from "node:crypto";
import { type CacheStore, versionedKey } from "./store.js";
import { resolveCacheStore } from "./resolve.js";

/** Same shape as providers' EmbeddingClient; kept local to avoid a cache→spec dep. */
export type Embedder = (texts: string[]) => Promise<number[][]>;

/** Cached value: one text's embedding vector. */
export interface CachedVector {
  vector: number[];
}

/** BUMP when the cached vector format changes (shared-store correctness). */
export const EMBED_CACHE_VERSION = "1";

function textKey(text: string, modelId: string): string {
  const contentKey = createHash("sha256").update(text, "utf8").digest("hex");
  return versionedKey(contentKey, modelId, EMBED_CACHE_VERSION);
}

/**
 * Wrap an embedder with a per-text content-addressed cache. Cached texts are
 * served from the store; only the misses are sent to `inner` (in one batch),
 * then stored. The result preserves input order.
 */
export function createCachedEmbedder(
  inner: Embedder,
  cache: CacheStore<CachedVector>,
  modelId: string,
): Embedder {
  return async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) return [];
    const keys = texts.map((t) => textKey(t, modelId));
    const out: (number[] | undefined)[] = await Promise.all(
      keys.map((k) => cache.get(k).then((v) => v?.vector)),
    );

    const missIdx: number[] = [];
    const missTexts: string[] = [];
    out.forEach((v, i) => {
      if (!v) {
        missIdx.push(i);
        missTexts.push(texts[i]!);
      }
    });

    if (missTexts.length > 0) {
      const fresh = await inner(missTexts);
      for (let j = 0; j < missIdx.length; j++) {
        const i = missIdx[j]!;
        const vec = fresh[j]!;
        out[i] = vec;
        await cache.set(keys[i]!, { vector: vec });
      }
    }
    return out as number[][];
  };
}

/**
 * Process-shared embedding cache (Redis > File > Memory, per ANATOMIA_CACHE_*).
 * Resolved once so every verify in a warm server reuses the same store.
 */
let shared: CacheStore<CachedVector> | undefined;
export function sharedEmbeddingCache(): CacheStore<CachedVector> {
  return (shared ??= resolveCacheStore<CachedVector>());
}
