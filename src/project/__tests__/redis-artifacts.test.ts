/** @spec Redis analysis result cache */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnalysisCache, ARTIFACT_CACHE_SCHEMA_VERSION } from "../cache.js";
import { readFile, writeFile } from "node:fs/promises";

vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), readFile: vi.fn(), writeFile: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); vi.mocked(readFile).mockRejectedValue(new Error("missing")); });
function store() {
  const entries = new Map<string, string>();
  return { entries, get: vi.fn(async (k: string) => entries.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { entries.set(k, v); }) };
}

describe("Redis returned analysis artifacts", () => {
  it("serves another cache instance without reading disk; isolates identity and fingerprint", async () => {
    const redis = store();
    await new AnalysisCache("/home", undefined, redis).writeArtifact("p", "review-a", "fp", { scores: [1, 2] });
    const reader = new AnalysisCache("/home", undefined, redis);
    expect(await reader.readArtifact("p", "review-a", "fp")).toEqual({ scores: [1, 2] });
    expect(readFile).not.toHaveBeenCalled();
    expect(reader.resultCacheStatus().redis.hits).toBe(1);
    for (const [home, project, name, fp] of [["/other", "p", "review-a", "fp"], ["/home", "q", "review-a", "fp"], ["/home", "p", "review_a", "fp"], ["/home", "p", "review-a", "changed"]]) {
      expect(await new AnalysisCache(home, undefined, redis).readArtifact(project!, name!, fp!)).toBeNull();
    }
  });
  it("promotes a disk hit and rejects an old Redis envelope", async () => {
    const redis = store(); const cache = new AnalysisCache("/home", undefined, redis);
    const payload = JSON.stringify({ version: ARTIFACT_CACHE_SCHEMA_VERSION, fingerprint: "fp", data: { value: 7 } });
    vi.mocked(readFile).mockResolvedValue(payload);
    expect(await cache.readArtifact("p", "review", "fp")).toEqual({ value: 7 });
    expect(redis.set).toHaveBeenCalledOnce();
    redis.get.mockResolvedValue(JSON.stringify({ version: -1, fingerprint: "fp", data: "bad" }));
    expect(await cache.readArtifact("p", "review", "fp")).toEqual({ value: 7 });
    expect(cache.resultCacheStatus().redis).toEqual({ hits: 0, misses: 2, writes: 2, errors: 0 });
  });
  it("reports unavailable Redis while retaining disk behavior without leaking errors", async () => {
    const redis = store(); redis.get.mockRejectedValue(new Error("redis://secret")); redis.set.mockRejectedValue(new Error("secret"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cache = new AnalysisCache("/home", undefined, redis);
    expect(await cache.readArtifact("p", "r", "fp")).toBeNull();
    await cache.writeArtifact("p", "r", "fp", { ok: true });
    expect(writeFile).toHaveBeenCalled(); expect(cache.resultCacheStatus().redis.errors).toBe(2);
    expect(warn).toHaveBeenCalledOnce(); expect(warn.mock.calls.flat().join()).not.toContain("secret"); warn.mockRestore();
  });
});
