/**
 * Domain-detection cache: key derivation (domains/cache.ts) and the analyze()
 * reuse path. The key must change when code identity (path or structural hash)
 * or the ontology changes, and analyze() must consult an injected detectionCache
 * so a fingerprint miss that left the code identical skips re-detection.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileNode } from "../../types.js";
import type { DomainOntology } from "../ontology.js";
import { loadOntology } from "../ontology.js";
import { detectionCacheKey } from "../cache.js";
import { createMemoryStore } from "../../cache/store.js";
import type { DetectionResult } from "../detect.js";
import { analyze } from "../../core.js";

const onto = (names: string[]): DomainOntology => ({
  domains: new Map(names.map((n) => [n, { name: n, description: n, presetRules: [], templateRules: [] }])),
});
const file = (path: string, hash: string): FileNode => ({ path, hash, functions: [] });

describe("detectionCacheKey", () => {
  const files = [file("/r/a.ts", "h1"), file("/r/b.ts", "h2")];
  const ontology = onto(["combat"]);

  it("is deterministic and order-independent over files", () => {
    const a = detectionCacheKey(files, ontology);
    const b = detectionCacheKey([files[1]!, files[0]!], ontology);
    expect(a).toBe(b);
  });

  it("changes when a file's structural hash changes", () => {
    const before = detectionCacheKey(files, ontology);
    const after = detectionCacheKey([file("/r/a.ts", "h1"), file("/r/b.ts", "CHANGED")], ontology);
    expect(after).not.toBe(before);
  });

  it("changes when a file is renamed (path matters for path-pattern rules)", () => {
    const before = detectionCacheKey(files, ontology);
    const after = detectionCacheKey([file("/r/renamed.ts", "h1"), file("/r/b.ts", "h2")], ontology);
    expect(after).not.toBe(before);
  });

  it("changes when the ontology changes", () => {
    const before = detectionCacheKey(files, ontology);
    const after = detectionCacheKey(files, onto(["combat", "movement"]));
    expect(after).not.toBe(before);
  });
});

describe("analyze detectionCache reuse", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "anatomia-detcache-"));
    await writeFile(join(root, "a.ts"), "export function a() { return 1; }\n");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serves a cached detection result instead of re-detecting", async () => {
    const cache = createMemoryStore<DetectionResult[]>();
    const first = await analyze(root, { quiet: true, detectionCache: cache });
    expect(first.domains).toBeDefined();

    // Overwrite the cache entry for this exact code identity + ontology with a
    // sentinel; a second analyze with the same code must return the sentinel,
    // proving it consulted the cache rather than re-running detectDomains.
    const ontology = await loadOntology();
    const key = detectionCacheKey(first.files, ontology);
    const sentinel: DetectionResult[] = [
      { domain: "SENTINEL", implementors: [], violations: [], conforms: true },
    ];
    await cache.set(key, sentinel);

    const second = await analyze(root, { quiet: true, detectionCache: cache });
    expect(second.domains).toEqual(sentinel);
  });

  it("recomputes (no sentinel) when no cache is supplied", async () => {
    const out = await analyze(root, { quiet: true });
    expect(out.domains?.some((d) => d.domain === "SENTINEL")).toBeFalsy();
  });
});
