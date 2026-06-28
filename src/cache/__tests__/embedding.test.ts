/**
 * createCachedEmbedder — per-text content-addressed embedding cache.
 *
 * The duplication gate embeds [changedCode, ...cardTexts] every verify. Caching
 * per text means the stable card texts are reused and only the changed code is
 * re-embedded — and the returned vectors must stay aligned to the input order.
 */

import { describe, it, expect } from "vitest";
import { createMemoryStore } from "../store.js";
import { createCachedEmbedder, type CachedVector, type Embedder } from "../embedding.js";

/** A deterministic fake embedder that counts how many texts it actually embedded. */
function countingEmbedder(): { embed: Embedder; embedded: string[] } {
  const embedded: string[] = [];
  const embed: Embedder = async (texts) => {
    embedded.push(...texts);
    return texts.map((t) => [t.length, t.charCodeAt(0) || 0]);
  };
  return { embed, embedded };
}

describe("createCachedEmbedder", () => {
  it("returns identical vectors to the inner embedder, in input order", async () => {
    const { embed } = countingEmbedder();
    const cache = createMemoryStore<CachedVector>();
    const cached = createCachedEmbedder(embed, cache, "m1");

    const raw = await embed(["alpha", "beta"]);
    const viaCache = await cached(["alpha", "beta"]);
    expect(viaCache).toEqual(raw);
  });

  it("only embeds the texts not already cached (per-text reuse)", async () => {
    const { embed, embedded } = countingEmbedder();
    const cache = createMemoryStore<CachedVector>();
    const cached = createCachedEmbedder(embed, cache, "m1");

    await cached(["newCodeA", "cardX", "cardY"]); // all miss
    expect(embedded).toEqual(["newCodeA", "cardX", "cardY"]);

    embedded.length = 0;
    // Same cards, different changed code → only the new code is embedded.
    const out = await cached(["newCodeB", "cardX", "cardY"]);
    expect(embedded).toEqual(["newCodeB"]);
    // Reused card vectors still align to their positions.
    expect(out[1]).toEqual([5, "c".charCodeAt(0)]); // "cardX".length=5
    expect(out[2]).toEqual([5, "c".charCodeAt(0)]); // "cardY".length=5
  });

  it("keeps order when only the middle text is a miss", async () => {
    const { embed, embedded } = countingEmbedder();
    const cache = createMemoryStore<CachedVector>();
    const cached = createCachedEmbedder(embed, cache, "m1");

    await cached(["a", "c"]); // prime a, c
    embedded.length = 0;
    const out = await cached(["a", "bb", "c"]); // only "bb" misses
    expect(embedded).toEqual(["bb"]);
    expect(out).toEqual([[1, 97], [2, 98], [1, 99]]);
  });

  it("separates vectors by embed model id (no cross-model collision)", async () => {
    const { embed, embedded } = countingEmbedder();
    const cache = createMemoryStore<CachedVector>();
    const m1 = createCachedEmbedder(embed, cache, "model-a");
    const m2 = createCachedEmbedder(embed, cache, "model-b");

    await m1(["shared"]);
    embedded.length = 0;
    await m2(["shared"]); // different model → must re-embed
    expect(embedded).toEqual(["shared"]);
  });

  it("handles an empty batch", async () => {
    const { embed, embedded } = countingEmbedder();
    const cached = createCachedEmbedder(embed, createMemoryStore<CachedVector>(), "m1");
    expect(await cached([])).toEqual([]);
    expect(embedded).toEqual([]);
  });
});
