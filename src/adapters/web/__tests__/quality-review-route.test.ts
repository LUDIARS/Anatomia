import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mountAnalysisRoutes } from "../routes/analysis.js";
import { webContextSourceFrom } from "../context.js";
import { InMemoryCodeGraph } from "../../../graph/in-memory.js";

describe("quality review HTTP contract", () => {
  it("returns unknown scores for an empty graph and versions the persisted artifact", async () => {
    const source = webContextSourceFrom({ repoPath: "/repo", files: [], functions: [], domains: [],
      graph: new InMemoryCodeGraph({ nodes: new Map(), edges: [], adjacency: new Map(), reverseAdjacency: new Map() }) });
    const cached = vi.spyOn(source, "cachedArtifact");
    const app = new Hono(); mountAnalysisRoutes(app, source);
    const response = await app.request("/api/projects/repo/review");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ quality: { version: 1, scores: {
      dependencySimplicity: { value: null }, domainCoverage: { value: null },
    }, opportunities: { total: 0, items: [] } } });
    expect(cached).toHaveBeenCalledWith("repo", "review-quality-v1", expect.any(Function));
  });
});
