/**
 * src/adapters/web/routes/cache.ts — Global LLM-cache stats route (A-3 measure).
 *
 * Route:
 *   GET /api/cache-stats   { enabled, logPath?, report? }
 *
 * The A-3 LLM cache hit-rate is a PROCESS-GLOBAL metric (not per-project): it is
 * aggregated from the JSONL transcript written when ANATOMIA_CACHE_LOG is set
 * (see cache/transcript.ts). When the env var is unset, measurement is off and
 * the route reports { enabled: false } so the panel can prompt the operator.
 *
 * SRP: HTTP routing + reading the env-configured transcript only. Event parsing
 * lives in cache/transcript.ts; aggregation in cache/stats.ts.
 */

import type { Hono } from "hono";
import { readEvents } from "../../../cache/transcript.js";
import { aggregate } from "../../../cache/stats.js";
import { estimateCost } from "../../../cache/cost-estimate.js";

/** Mount the global cache-stats route on `app`.
 *
 * `?session=<id>` adds a `session` view (that slice's tally + cost estimate) so a
 * caller — e.g. the Concordia status card — can show "this session's" hit rate
 * and estimated USD without re-reading the transcript itself. `cost` is the
 * global cost estimate; both are null when there are no events for that slice. */
export function mountCacheRoute(app: Hono): void {
  app.get("/api/cache-stats", async (c) => {
    const logPath = process.env["ANATOMIA_CACHE_LOG"];
    if (!logPath) {
      return c.json({ enabled: false as const });
    }
    const events = await readEvents(logPath);
    const report = aggregate(events);
    const sessionId = c.req.query("session");
    const cost = estimateCost(report);
    const session = sessionId
      ? { id: sessionId, tally: report.bySession[sessionId] ?? null, cost: estimateCost(report, { session: sessionId }) }
      : undefined;
    return c.json({ enabled: true as const, logPath, report, cost, session });
  });
}
