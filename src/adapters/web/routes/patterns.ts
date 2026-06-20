/**
 * src/adapters/web/routes/patterns.ts — Access-pattern route.
 *
 * Route:
 *   GET /api/projects/:id/access-patterns
 *     → AccessPattern[] (patterns/detect.ts): heuristically-detected
 *       singleton / service-locator / facade nodes, each with the domains that
 *       reach it and how. The Domain View overlays these to mark cross-cutting
 *       hubs and show "which domain accesses what".
 *
 * SRP: HTTP routing + 404 shaping. Detection lives in patterns/detect.ts.
 */

import type { Hono } from "hono";
import { detectAccessPatterns } from "../../../patterns/detect.js";
import type { WebContextSource } from "../context.js";

export function mountPatternRoutes(app: Hono, source: WebContextSource): void {
  app.get("/api/projects/:id/access-patterns", async (c) => {
    const id = c.req.param("id");
    let ctx;
    try {
      ctx = await source.resolve(id);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }
    const patterns = await detectAccessPatterns(ctx);
    return c.json(patterns);
  });
}
