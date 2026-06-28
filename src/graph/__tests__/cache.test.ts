/**
 * Built-graph cache: key derivation (graph/cache.ts) and the analyze() reuse
 * path. The key must change with code identity (path or structural hash), and
 * analyze() must reuse the SAME CodeGraph object when an injected graphCache has
 * one for unchanged code — so a fingerprint miss that left the code identical
 * (spec/config edit) skips edge extraction + graph build.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileNode } from "../../types.js";
import type { CodeGraph } from "../build.js";
import { filesContentKey, graphCacheKey } from "../cache.js";
import { createMemoryStore } from "../../cache/store.js";
import { analyze } from "../../core.js";

const file = (path: string, hash: string): FileNode => ({ path, hash, functions: [] });

describe("filesContentKey / graphCacheKey", () => {
  const files = [file("/r/a.ts", "h1"), file("/r/b.ts", "h2")];

  it("is deterministic and order-independent", () => {
    expect(filesContentKey(files)).toBe(filesContentKey([files[1]!, files[0]!]));
    expect(graphCacheKey(files)).toBe(graphCacheKey([files[1]!, files[0]!]));
  });

  it("changes on a content edit or a rename", () => {
    const base = graphCacheKey(files);
    expect(graphCacheKey([file("/r/a.ts", "X"), file("/r/b.ts", "h2")])).not.toBe(base);
    expect(graphCacheKey([file("/r/moved.ts", "h1"), file("/r/b.ts", "h2")])).not.toBe(base);
  });
});

describe("analyze graphCache reuse", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "anatomia-graphcache-"));
    await writeFile(join(root, "a.ts"), "export function a() { return b(); }\nfunction b() { return 1; }\n");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reuses the same CodeGraph object for unchanged code", async () => {
    const graphCache = createMemoryStore<CodeGraph>();
    const first = await analyze(root, { quiet: true, graphCache });
    const second = await analyze(root, { quiet: true, graphCache });
    // Same code identity → graph cache hit → the very same raw CodeGraph object.
    expect(second.graph.raw).toBe(first.graph.raw);
  });

  it("rebuilds (new object) when the code changes", async () => {
    const graphCache = createMemoryStore<CodeGraph>();
    const first = await analyze(root, { quiet: true, graphCache });
    await writeFile(join(root, "a.ts"), "export function a() { return 42; }\n");
    const second = await analyze(root, { quiet: true, graphCache });
    expect(second.graph.raw).not.toBe(first.graph.raw);
  });

  it("rebuilds every time when no cache is supplied", async () => {
    const first = await analyze(root, { quiet: true });
    const second = await analyze(root, { quiet: true });
    expect(second.graph.raw).not.toBe(first.graph.raw);
  });
});
