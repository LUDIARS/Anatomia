/**
 * src/adapters/web/routes/branch.ts — Branch-diff analysis route.
 *
 * Routes:
 *   GET /api/projects/:id/branch-diff[?base=<ref>]
 *     → BranchDiff (branch/diff.ts): the function-level delta this branch
 *       introduced relative to its fork point, with the added/changed anchors
 *       that the panel filters the main graph down to.
 *   GET /api/projects/:id/branches
 *     → { current, autoBase, candidates[] }: base refs the panel offers in its
 *       base selector (so the user can diff against any branch, not just auto).
 *
 * SRP: HTTP routing + 404 shaping. Diff + git access live in branch/*; the
 * AnalysisContext (warm full analysis) is resolved through WebContextSource.
 */

import type { Hono } from "hono";
import { computeBranchDiff } from "../../../branch/diff.js";
import { currentBranch, listBranches, resolveBase } from "../../../branch/git.js";
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

  app.get("/api/projects/:id/branches", async (c) => {
    const id = c.req.param("id");
    let ctx;
    try {
      ctx = await source.resolve(id);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }
    const root = ctx.repoPath;
    const [current, candidates, resolved] = await Promise.all([
      currentBranch(root),
      listBranches(root),
      resolveBase(root),
    ]);
    return c.json({ current, autoBase: resolved?.ref ?? null, candidates });
  });
}
