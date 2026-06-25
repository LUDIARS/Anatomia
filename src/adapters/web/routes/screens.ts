/**
 * src/adapters/web/routes/screens.ts — Screen-composition route.
 *
 * Route:
 *   GET /api/projects/:id/screens
 *     → ScreenGraph (screens/detect.ts): heuristically-detected UI screens with
 *       their composition (contains) + navigation (navigatesTo) + owning domains.
 *
 * SRP: HTTP routing + 404 shaping. Detection lives in screens/detect.ts.
 */

import type { Hono } from "hono";
import { detectScreens } from "../../../screens/index.js";
import type { WebContextSource } from "../context.js";

export function mountScreenRoutes(app: Hono, source: WebContextSource): void {
  app.get("/api/projects/:id/screens", async (c) => {
    const id = c.req.param("id");
    let ctx;
    try {
      ctx = await source.resolve(id);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }
    const graph = await detectScreens(ctx);
    return c.json(graph);
  });
}
