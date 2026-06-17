/**
 * src/adapters/web/routes/cost.ts — Cross-service cost-feed routes.
 *
 * Routes:
 *   POST /api/cost-feed   ingest per-session cost summaries from a service
 *   GET  /api/cost-feed   aggregated report for the panel
 *
 * POST body:
 *   { service: string, ts?: number, sessions: [
 *       { sessionId, model?, backend?, calls, inputTokens, outputTokens,
 *         cacheReadTokens, cacheCreationTokens, costUsd }
 *   ] }
 *
 * SRP: HTTP routing + minimal validation only. Store in cost/feed.ts;
 * aggregation in cost/aggregate.ts.
 */

import type { Hono } from "hono";
import { getCostFeed, type CostFeed, type CostFeedEntry } from "../../../cost/feed.js";
import { aggregateCostFeed } from "../../../cost/aggregate.js";

interface IncomingRow {
  sessionId?: unknown;
  model?: unknown;
  backend?: unknown;
  calls?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheCreationTokens?: unknown;
  costUsd?: unknown;
}

interface IncomingBody {
  service?: unknown;
  ts?: unknown;
  sessions?: unknown;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Mount the cost-feed routes. `feed` defaults to the env-resolved singleton. */
export function mountCostRoute(app: Hono, feed: CostFeed = getCostFeed()): void {
  app.post("/api/cost-feed", async (c) => {
    let body: IncomingBody;
    try {
      body = (await c.req.json()) as IncomingBody;
    } catch {
      return c.json({ ok: false, error: "invalid json" }, 400);
    }
    const service = str(body.service)?.trim();
    if (!service) return c.json({ ok: false, error: "service required" }, 400);

    const rows = Array.isArray(body.sessions) ? (body.sessions as IncomingRow[]) : [];
    const ts = num(body.ts) || Date.now();

    let recorded = 0;
    for (const r of rows) {
      const sessionId = str(r?.sessionId)?.trim();
      if (!sessionId) continue;
      const entry: CostFeedEntry = {
        ts,
        service,
        sessionId,
        model: str(r.model),
        backend: str(r.backend),
        calls: num(r.calls),
        inputTokens: num(r.inputTokens),
        outputTokens: num(r.outputTokens),
        cacheReadTokens: num(r.cacheReadTokens),
        cacheCreationTokens: num(r.cacheCreationTokens),
        costUsd: num(r.costUsd),
      };
      feed.record(entry);
      recorded++;
    }
    await feed.flush();
    return c.json({ ok: true as const, recorded });
  });

  app.get("/api/cost-feed", async (c) => {
    const entries = await feed.read();
    return c.json(aggregateCostFeed(entries));
  });
}
