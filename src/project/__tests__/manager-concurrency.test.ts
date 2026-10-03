/** Hermetic manager-level regression for simultaneous Cc/API consumers. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectManager } from "../manager.js";
import { ProjectRegistry } from "../registry.js";
import { analyze } from "../../core.js";
import type { AnalysisContext } from "../../core.js";
import { InMemoryCodeGraph } from "../../graph/in-memory.js";
import { SNAPSHOT_CACHE_SCHEMA_VERSION } from "../cache.js";

const fingerprint = vi.hoisted(() => vi.fn(async () => "fp1"));
vi.mock("../cache.js", async (original) => ({ ...await original<typeof import("../cache.js")>(), computeFingerprint: fingerprint }));
vi.mock("../../core.js", async (original) => ({ ...await original<typeof import("../../core.js")>(), analyze: vi.fn() }));
vi.mock("../../spec/stability.js", () => ({ recordAnalysis: vi.fn(async () => undefined) }));
vi.mock("../../knowledge/write-root.js", () => ({ resolveKnowledgeWriteRoot: () => undefined }));
vi.mock("../config-paths.js", () => ({ effectiveOntologyDir: () => undefined, effectiveSpecDirs: () => undefined, effectiveConfigDirs: () => [] }));

function context(): AnalysisContext {
  return { repoPath: "/repo", files: [], functions: [], domains: [],
    graph: new InMemoryCodeGraph({ nodes: new Map(), edges: [], adjacency: new Map(), reverseAdjacency: new Map() }) };
}

function manager(): ProjectManager {
  const registry = new ProjectRegistry();
  registry.add({ name: "sample", rootPath: "/repo" });
  const mgr = new ProjectManager(registry);
  vi.spyOn(mgr, "ensureSpecConfig").mockResolvedValue({ source: "root" });
  const cached = new Map<string, { fingerprint: string; ctx: AnalysisContext }>();
  vi.spyOn(mgr.cache, "getIfFresh").mockImplementation((id, fp) => {
    const entry = cached.get(id);
    return entry?.fingerprint === fp ? entry.ctx : null;
  });
  vi.spyOn(mgr.cache, "put").mockImplementation(async (id, fp, ctx) => {
    cached.set(id, { fingerprint: fp, ctx });
    return { version: SNAPSHOT_CACHE_SCHEMA_VERSION, projectId: id, fingerprint: fp,
      merkleHash: "test", fileCount: 0, functionCount: 0, analyzedAt: "2026-10-03T00:00:00.000Z",
      summary: { files: 0, functions: 0, nodes: 0, edges: 0, domains: 0, links: 0 } };
  });
  vi.spyOn(mgr.cache, "readArtifact").mockResolvedValue(null);
  vi.spyOn(mgr.cache, "writeArtifact").mockResolvedValue(undefined);
  return mgr;
}

beforeEach(() => {
  vi.clearAllMocks();
  fingerprint.mockResolvedValue("fp1");
  vi.mocked(analyze).mockImplementation(async () => context());
});

describe("ProjectManager concurrent requests", () => {
  it("shares analysis between different artifacts and builds identical artifacts once", async () => {
    const mgr = manager();
    const first = vi.fn(async () => ({ score: 70 }));
    const second = vi.fn(async () => ({ domains: 2 }));
    const results = await Promise.all([
      mgr.cachedArtifact("sample", "score-v1", first),
      mgr.cachedArtifact("sample", "score-v1", first),
      mgr.cachedArtifact("sample", "domains-v1", second),
      mgr.getContext("sample"),
    ]);
    expect(results[0]).toBe(results[1]);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(mgr.cache.put).toHaveBeenCalledTimes(1);
    expect(mgr.cache.writeArtifact).toHaveBeenCalledTimes(2);
  });

  it("releases a failed shared analysis so the next request can recover", async () => {
    const mgr = manager();
    vi.mocked(analyze).mockRejectedValueOnce(new Error("parser unavailable"));
    const results = await Promise.allSettled([mgr.getContext("sample"), mgr.getContext("sample")]);
    expect(results.map(r => r.status)).toEqual(["rejected", "rejected"]);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(await mgr.getContext("sample")).toMatchObject({ repoPath: "/repo" });
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it("separates fingerprints and never shares partial analysis as a full result", async () => {
    const mgr = manager();
    await Promise.all([mgr.getContext("sample"), mgr.analyzeProject("sample", { scope: { domains: false } })]);
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(mgr.cache.put).toHaveBeenCalledTimes(1);
    fingerprint.mockResolvedValue("fp2");
    await mgr.getContext("sample");
    expect(analyze).toHaveBeenCalledTimes(3);
  });

  it("does not cache an artifact failure and retries its builder", async () => {
    const mgr = manager();
    const build = vi.fn<() => Promise<number>>().mockRejectedValueOnce(new Error("projection failed")).mockResolvedValue(12);
    const results = await Promise.allSettled([mgr.cachedArtifact("sample", "score", build), mgr.cachedArtifact("sample", "score", build)]);
    expect(results.every(r => r.status === "rejected")).toBe(true);
    expect(build).toHaveBeenCalledTimes(1);
    expect(await mgr.cachedArtifact("sample", "score", build)).toBe(12);
    expect(mgr.cache.writeArtifact).toHaveBeenCalledTimes(1);
  });
});
