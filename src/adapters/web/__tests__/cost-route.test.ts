/**
 * POST/GET /api/cost-feed — ingest validation + aggregation round-trip.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { mountCostRoute } from "../routes/cost.js";
import { createMemoryCostFeed } from "../../../cost/feed.js";

function appWithFeed() {
  const app = new Hono();
  mountCostRoute(app, createMemoryCostFeed());
  return app;
}

const post = (app: Hono, body: unknown) =>
  app.request("/api/cost-feed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("cost-feed route", () => {
  it("ingests rows and aggregates them on GET", async () => {
    const app = appWithFeed();
    const res = await post(app, {
      service: "discutere",
      ts: 100,
      sessions: [
        { sessionId: "S1", model: "opus", backend: "claude-cli", calls: 2, costUsd: 0.02, cacheReadTokens: 100 },
        { sessionId: "S2", model: "haiku", backend: "claude-cli", calls: 1, costUsd: 0.005 },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, recorded: 2 });

    const report = await (await app.request("/api/cost-feed")).json();
    expect(report.total.calls).toBe(3);
    expect(report.total.costUsd).toBeCloseTo(0.025, 9);
    expect(report.total.sessions).toBe(2);
    expect(report.byService.find((a: { key: string }) => a.key === "discutere").calls).toBe(3);
  });

  it("re-pushing the same session replaces (latest wins, no double count)", async () => {
    const app = appWithFeed();
    await post(app, { service: "discutere", ts: 1, sessions: [{ sessionId: "S1", model: "opus", backend: "cli", calls: 1, costUsd: 0.01 }] });
    await post(app, { service: "discutere", ts: 2, sessions: [{ sessionId: "S1", model: "opus", backend: "cli", calls: 4, costUsd: 0.04 }] });
    const report = await (await app.request("/api/cost-feed")).json();
    expect(report.total.calls).toBe(4); // not 5
    expect(report.total.costUsd).toBeCloseTo(0.04, 9);
  });

  it("rejects missing service with 400", async () => {
    const app = appWithFeed();
    const res = await post(app, { sessions: [{ sessionId: "S1" }] });
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
  });

  it("rejects invalid json with 400", async () => {
    const app = appWithFeed();
    const res = await app.request("/api/cost-feed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("skips rows without sessionId, coerces non-numbers to 0", async () => {
    const app = appWithFeed();
    const res = await post(app, {
      service: "discutere",
      sessions: [
        { model: "opus" }, // no sessionId → skipped
        { sessionId: "S1", calls: "oops", costUsd: 0.01 }, // calls non-number → 0
      ],
    });
    expect((await res.json()).recorded).toBe(1);
    const report = await (await app.request("/api/cost-feed")).json();
    expect(report.total.calls).toBe(0);
    expect(report.total.costUsd).toBeCloseTo(0.01, 9);
  });
});
