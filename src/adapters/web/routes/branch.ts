/**
 * src/adapters/web/routes/branch.ts — Branch-diff analysis route.
 *
 * Route:
 *   GET /api/projects/:id/branch-diff[?base=<ref>]
 *     → BranchDiff (branch/diff.ts): the function-level delta this branch
 *       introduced relative to its fork point, with the added/changed anchors
 *       that the panel filters the main graph down to.
 *
 * SRP: HTTP routing + 404 shaping. The diff is computed in branch/diff.ts; the
 * AnalysisContext (warm full analysis) is resolved through WebContextSource.
 */

import type { Hono } from "hono";
import { computeBranchDiff } from "../../../branch/diff.js";
import type { WebContextSource } from "../context.js";

export function mountBranchRoutes(app: Hono, source: WebContextSource): void {
  app.get("/api/projects/:id/branch-diff", async (c) => {
    const id = c.req.param("id");
    let ctx;
    try {
      ctx = await source.resolve(id);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }
    const base = c.req.query("base") || undefined;
    const diff = await computeBranchDiff(ctx, { base });
    return c.json(diff);
  });
}
