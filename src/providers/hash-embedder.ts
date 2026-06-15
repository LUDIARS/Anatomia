/**
 * Deterministic hash embedder (A-2) — offline fallback.
 *
 * When no embeddings backend is configured, the duplication gate would
 * otherwise run against zero vectors (cosine = 0, gate always passes — the
 * "ザル" failure mode noted in follow-ups). This token-bag hash embedder gives
 * the gate a *real* lexical-overlap similarity signal with zero dependencies
 * and full determinism (good for tests + air-gapped runs).
 *
 * It is NOT a semantic embedder — two paraphrases with no shared tokens look
 * dissimilar. For meaningful semantic duplication detection, configure a real
 * embedder (openai-embedder.ts). This is the floor, not the target.
 *
 * SRP: tokenise -> hash into a fixed-dimension term-frequency vector.
 */

import type { EmbeddingClient } from "../spec/semantic.js";

const DEFAULT_DIM = 256;

/** FNV-1a 32-bit hash (deterministic, fast, no deps). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function embedOne(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  for (const tok of tokens) {
    v[fnv1a(tok) % dim] += 1;
  }
  return v;
}

/** Build a deterministic offline EmbeddingClient (token-bag hashing). */
export function createHashEmbedder(dim: number = DEFAULT_DIM): EmbeddingClient {
  const d = dim > 0 ? dim : DEFAULT_DIM;
  return async (texts: string[]): Promise<number[][]> => texts.map((t) => embedOne(t, d));
}
