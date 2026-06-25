/**
 * src/web-cache/store.test.ts — write/read roundtrip + absent-view → null.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWebCache, readWebManifest, readWebView } from "./store.js";
import type { WebCacheBundle, SceneModulesPayload, SearchCorpus } from "./types.js";

const scene: SceneModulesPayload = { hasScenes: false, scenes: [], domains: [] };
const corpus: SearchCorpus = { entries: [{ kind: "domain", ref: "d", title: "d" }] };

const bundle: WebCacheBundle = {
  graph: { nodes: [1, 2, 3], edges: [] },
  "domain-view": { views: [{}, {}] },
  "access-patterns": [],
  hotspots: [{ a: 1 }],
  "spec-links": [],
  domains: [{ domain: "d" }],
  "scene-modules": scene,
  "search-corpus": corpus,
};

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "anatomia-webcache-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("web cache store", () => {
  it("writes a manifest + per-view envelopes and reads them back", async () => {
    const manifest = await writeWebCache(dir, "proj1", "fp-123", bundle, "2026-06-23T00:00:00.000Z");
    expect(manifest.projectId).toBe("proj1");
    expect(manifest.fingerprint).toBe("fp-123");
    expect(manifest.preparedAt).toBe("2026-06-23T00:00:00.000Z");
    expect(manifest.views).toContain("scene-modules");
    // counts: arrays by length, structured views by their core list.
    expect(manifest.counts["graph"]).toBe(3);
    expect(manifest.counts["search-corpus"]).toBe(1);
    expect(manifest.counts["hotspots"]).toBe(1);

    const read = await readWebManifest(dir);
    expect(read?.fingerprint).toBe("fp-123");

    const env = await readWebView<SearchCorpus>(dir, "search-corpus");
    expect(env?.preparedAt).toBe("2026-06-23T00:00:00.000Z");
    expect(env?.data.entries[0]!.ref).toBe("d");
  });

  it("returns null for a never-prepared project / view", async () => {
    expect(await readWebManifest(join(dir, "nope"))).toBeNull();
    expect(await readWebView(join(dir, "nope"), "graph")).toBeNull();
  });
});
