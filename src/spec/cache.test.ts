/**
 * Spec-link cache: key derivation (spec/cache.ts) and the analyze() reuse
 * path. The key must change with spec content or source identity, and
 * analyze() must NOT re-run the linkers when an injected specLinkCache has a
 * result for unchanged inputs (asserted via a spy on findExplicitLinks /
 * findStructuralLinks).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileNode } from "../types.js";
import { specLinkContentKey, specLinkCacheKey, type SpecLinkResult } from "./cache.js";
import { createMemoryStore } from "../cache/store.js";
import { analyze } from "../core.js";
import { findExplicitLinks } from "./explicit.js";
import { findStructuralLinks } from "./structural.js";

// Wrap the linkers in spies (behaviour unchanged) so the reuse test can
// assert "cache hit → linker NOT re-run" directly.
vi.mock("./explicit.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./explicit.js")>();
  return { ...mod, findExplicitLinks: vi.fn(mod.findExplicitLinks) };
});
vi.mock("./structural.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./structural.js")>();
  return { ...mod, findStructuralLinks: vi.fn(mod.findStructuralLinks) };
});

const src = (path: string, contentHash: string): FileNode =>
  ({ path, hash: null, contentHash, functions: [] });
const spec = (path: string, content: string) => ({ path, content });

describe("specLinkContentKey / specLinkCacheKey", () => {
  const specs = [spec("/r/spec/a.md", "# A"), spec("/r/DESIGN.md", "# D")];
  const files = [src("/r/x.ts", "h1"), src("/r/y.ts", "h2")];

  it("is deterministic and order-independent", () => {
    expect(specLinkContentKey(specs, files)).toBe(
      specLinkContentKey([specs[1]!, specs[0]!], [files[1]!, files[0]!]),
    );
    expect(specLinkCacheKey(specs, files)).toBe(
      specLinkCacheKey([specs[1]!, specs[0]!], [files[1]!, files[0]!]),
    );
  });

  it("changes on a spec content edit or spec rename", () => {
    const base = specLinkCacheKey(specs, files);
    expect(specLinkCacheKey([spec("/r/spec/a.md", "# A2"), specs[1]!], files)).not.toBe(base);
    expect(specLinkCacheKey([spec("/r/spec/moved.md", "# A"), specs[1]!], files)).not.toBe(base);
  });

  it("changes on a source content edit or source rename", () => {
    const base = specLinkCacheKey(specs, files);
    expect(specLinkCacheKey(specs, [src("/r/x.ts", "X"), files[1]!])).not.toBe(base);
    expect(specLinkCacheKey(specs, [src("/r/moved.ts", "h1"), files[1]!])).not.toBe(base);
  });
});

describe("analyze specLinkCache reuse", () => {
  let root: string;
  beforeEach(async () => {
    vi.mocked(findExplicitLinks).mockClear();
    vi.mocked(findStructuralLinks).mockClear();
    root = await mkdtemp(join(tmpdir(), "anatomia-speclinkcache-"));
    await writeFile(join(root, "hash.ts"), "export function hashThing() { return 1; }\n");
    await writeFile(join(root, "spec.md"), "# Hash\nThe hash lives in hash.ts.\n");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("does not re-run the linkers on a cache hit (same result object)", async () => {
    const specLinkCache = createMemoryStore<SpecLinkResult>();
    const first = await analyze(root, { quiet: true, specLinkCache });
    expect(vi.mocked(findExplicitLinks)).toHaveBeenCalledTimes(1);
    expect(first.links!.length).toBeGreaterThan(0);

    const second = await analyze(root, { quiet: true, specLinkCache });
    // Hit → linkers not re-run; clauses are the very same array by reference.
    // (links get re-merged with the persisted ratified set per analyze, so
    // they are equal in content but not by reference.)
    expect(vi.mocked(findExplicitLinks)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(findStructuralLinks)).toHaveBeenCalledTimes(1);
    expect(second.links).toEqual(first.links);
    expect(second.specClauses).toBe(first.specClauses);
  });

  it("relinks when the spec content changes", async () => {
    const specLinkCache = createMemoryStore<SpecLinkResult>();
    const first = await analyze(root, { quiet: true, specLinkCache });
    await writeFile(join(root, "spec.md"), "# Hash v2\nStill about hash.ts.\n");
    const second = await analyze(root, { quiet: true, specLinkCache });
    expect(vi.mocked(findExplicitLinks)).toHaveBeenCalledTimes(2);
    expect(second.links).not.toBe(first.links);
  });

  it("relinks when a source file's content changes", async () => {
    const specLinkCache = createMemoryStore<SpecLinkResult>();
    await analyze(root, { quiet: true, specLinkCache });
    // A comment-only edit must bust the key (annotations live in comments).
    await writeFile(
      join(root, "hash.ts"),
      "// @spec Hash\nexport function hashThing() { return 1; }\n",
    );
    await analyze(root, { quiet: true, specLinkCache });
    expect(vi.mocked(findExplicitLinks)).toHaveBeenCalledTimes(2);
  });

  it("relinks every time when no cache is supplied", async () => {
    await analyze(root, { quiet: true });
    await analyze(root, { quiet: true });
    expect(vi.mocked(findExplicitLinks)).toHaveBeenCalledTimes(2);
  });
});
