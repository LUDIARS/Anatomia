/**
 * src/web-cache/store.test.ts — write/read roundtrip + absent-view → null.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeWebCache,
  readWebGraphSlice,
  readWebManifest,
  readWebView,
  webDir,
} from "./store.js";
import {
  WEB_CACHE_SCHEMA_VERSION,
  type WebCacheBundle,
  type SceneModulesPayload,
  type SceneViewPayload,
  type SearchCorpus,
} from "./types.js";

const scene: SceneModulesPayload = { hasScenes: false, scenes: [] };
const sceneView: SceneViewPayload = { scenes: [] };
const corpus: SearchCorpus = { entries: [{ kind: "domain", ref: "d", title: "d" }] };

const bundle: WebCacheBundle = {
  graph: { nodes: [1, 2, 3], edges: [] },
  "domain-view": { views: [{}, {}] },
  "business-domain-view": { domains: [], relations: [], unlinkedProgramDomains: [] },
  "program-domain-view": { layers: [], diagnostics: [], classDiagram: { nodes: [], edges: [] }, dependencies: [], modularity: 0, proposals: [] },
  "access-patterns": [],
  hotspots: [{ a: 1 }],
  "spec-links": [],
  domains: [{ domain: "d" }],
  "scene-modules": scene,
  "scene-view": sceneView,
  "entrypoint-view": { entries: [], nodes: [], edges: [], unrooted: [], diagnostics: [] },
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
    expect(manifest.version).toBe(WEB_CACHE_SCHEMA_VERSION);
    expect(manifest.views).toContain("scene-modules");
    // counts: arrays by length, structured views by their core list.
    expect(manifest.counts["graph"]).toBe(3);
    expect(manifest.counts["search-corpus"]).toBe(1);
    expect(manifest.counts["hotspots"]).toBe(1);

    const read = await readWebManifest(dir);
    expect(read?.fingerprint).toBe("fp-123");

    const env = await readWebView<SearchCorpus>(dir, "search-corpus");
    expect(env?.version).toBe(WEB_CACHE_SCHEMA_VERSION);
    expect(env?.preparedAt).toBe("2026-06-23T00:00:00.000Z");
    expect(env?.data.entries[0]!.ref).toBe("d");
  });

  it("returns null for a never-prepared project / view", async () => {
    expect(await readWebManifest(join(dir, "nope"))).toBeNull();
    expect(await readWebView(join(dir, "nope"), "graph")).toBeNull();
  });

  it("counts function nodes from a graph overview manifest", async () => {
    const overviewBundle: WebCacheBundle = {
      ...bundle,
      graph: {
        schema: "graph-overview-v1",
        overview: { nodes: [{ id: "group" }], edges: [] },
        summary: { funcCount: 37 },
      },
    };
    const manifest = await writeWebCache(
      join(dir, "overview"),
      "proj-overview",
      "fp-overview",
      overviewBundle,
      "2026-06-23T00:00:00.000Z",
    );
    expect(manifest.counts.graph).toBe(37);
  });

  it("rejects malformed graph-slice keys instead of aliasing them", async () => {
    await expect(readWebGraphSlice(dir, "function", "aa/../0123456789abcdef"))
      .resolves.toBeNull();
  });

  it("rejects every legacy prepared-cache envelope", async () => {
    const legacyDir = join(dir, "legacy");
    const legacyWebDir = webDir(legacyDir);
    await mkdir(legacyWebDir, { recursive: true });
    await writeFile(
      join(legacyWebDir, "manifest.json"),
      JSON.stringify({
        version: 2,
        projectId: "legacy",
        preparedAt: "2026-01-01T00:00:00.000Z",
        fingerprint: "same-source",
        views: ["graph"],
        counts: { graph: 1 },
      }),
      "utf8",
    );
    await writeFile(
      join(legacyWebDir, "graph.json"),
      JSON.stringify({
        version: 2,
        view: "graph",
        preparedAt: "2026-01-01T00:00:00.000Z",
        fingerprint: "same-source",
        data: { nodes: [{ _meta: { domain: null } }] },
      }),
      "utf8",
    );

    await expect(readWebManifest(legacyDir)).resolves.toBeNull();
    await expect(readWebView(legacyDir, "graph")).resolves.toBeNull();
  });
});
