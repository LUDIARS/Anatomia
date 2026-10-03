/** @spec Redis analysis result cache */
import { expect, it } from "vitest";
import { Hono } from "hono";
import { mountCacheRoute } from "../routes/cache.js";
it("exposes observed Redis use separately from configuration without connection secrets", async () => {
  const app = new Hono(); const status = { backend: "redis+disk", redis: { hits: 2, misses: 1, writes: 1, errors: 0 }, artifactHits: 2, artifactMisses: 1 };
  mountCacheRoute(app, { resultCacheStatus: () => status });
  expect(await (await app.request("/api/analysis-cache")).json()).toEqual(status);
});
