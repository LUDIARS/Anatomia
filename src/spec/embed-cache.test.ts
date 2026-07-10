/**
 * Semantic-linker wiring (B-2): analyze() runs findSemanticLinks only when an
 * embedder capability is injected (observable via ctx.semanticLinked), the
 * per-text embedding cache cuts embedder calls on re-analysis, and the
 * spec-link cache key folds the embedder identity.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileNode } from "../types.js";
import type { Providers } from "../providers/index.js";
import { cachedEmbeddingClient } from "./embed-cache.js";
import { specLinkCacheKey } from "./cache.js";
import { createMemoryStore } from "../cache/store.js";
import type { CachedVector } from "../cache/embedding.js";
import { analyze } from "../core.js";

function testProviders(embedModelId: string): Providers & { embed: ReturnType<typeof vi.fn> } {
  const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
  return {
    llm: async () => "",
    embed,
    llmModelId: "stub-llm",
    embedModelId,
    describe: () => `test-embed(${embedModelId})`,
  };
}

describe("cachedEmbeddingClient", () => {
  it("serves repeats from the cache and embeds only the misses", async () => {
    const inner = vi.fn(async (texts: string[]) => texts.map((t) => [t.length, 1]));
    const cache = createMemoryStore<CachedVector>();
    const client = cachedEmbeddingClient(inner, cache, "m1");

    const first = await client(["alpha", "beta"]);
    expect(inner).toHaveBeenCalledTimes(1);

    // Full hit → no inner call, identical vectors (determinism kept).
    const second = await client(["alpha", "beta"]);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);

    // Partial hit → only the new text goes to the embedder.
    await client(["alpha", "gamma"]);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(inner).toHaveBeenLastCalledWith(["gamma"]);
  });

  it("a different embedder id never serves the other's vectors", async () => {
    const inner = vi.fn(async (texts: string[]) => texts.map(() => [2, 2]));
    const cache = createMemoryStore<CachedVector>();
    await cachedEmbeddingClient(inner, cache, "m1")(["alpha"]);
    await cachedEmbeddingClient(inner, cache, "m2")(["alpha"]);
    expect(inner).toHaveBeenCalledTimes(2);
  });
});

describe("specLinkCacheKey folds the embedder identity", () => {
  it("with/without an embedder (and across models) the keys differ", () => {
    const specs = [{ path: "/r/spec.md", content: "# A" }];
    const files: FileNode[] = [{ path: "/r/x.ts", hash: null, contentHash: "h1", functions: [] }];
    const none = specLinkCacheKey(specs, files);
    const m1 = specLinkCacheKey(specs, files, "embed-m1");
    const m2 = specLinkCacheKey(specs, files, "embed-m2");
    expect(m1).not.toBe(none);
    expect(m2).not.toBe(m1);
    expect(specLinkCacheKey(specs, files, "embed-m1")).toBe(m1);
  });
});

describe("analyze semantic wiring", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "anatomia-semantic-"));
    await writeFile(join(root, "hash.ts"), "export function hashThing() { return 1; }\n");
    // No keyword overlap with the clause → semantic-only pair (structural and
    // explicit both stay silent for this file).
    await writeFile(join(root, "zebra.ts"), "export function zebraThing() { return 2; }\n");
    await writeFile(join(root, "spec.md"), "# Hash\nHashing rules live here.\n");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("mixes semantic links in when an embedder is injected (semanticLinked=true)", async () => {
    const providers = testProviders(`sem-${Date.now()}-a`);
    const ctx = await analyze(root, { quiet: true, providers });
    expect(ctx.semanticLinked).toBe(true);
    const zebra = ctx.links!.filter((l) => String(l.from).includes("zebra"));
    expect(zebra.length).toBeGreaterThan(0);
    expect(zebra.every((l) => l.evidence === "semantic")).toBe(true);
    expect(providers.embed).toHaveBeenCalled();
  });

  it("skips semantic linking without an embedder (semanticLinked=false)", async () => {
    const ctx = await analyze(root, { quiet: true });
    expect(ctx.semanticLinked).toBe(false);
    expect(ctx.links!.some((l) => l.evidence === "semantic")).toBe(false);
  });

  it("re-analysis embeds nothing new (per-text cache hit)", async () => {
    const providers = testProviders(`sem-${Date.now()}-b`);
    await analyze(root, { quiet: true, providers });
    const callsAfterFirst = providers.embed.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    await analyze(root, { quiet: true, providers });
    // All clause/code texts unchanged → every vector comes from the cache.
    expect(providers.embed.mock.calls.length).toBe(callsAfterFirst);
  });
});
