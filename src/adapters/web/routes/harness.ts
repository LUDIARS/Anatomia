/**
 * src/adapters/web/routes/harness.ts — Warm supply/verify endpoints for the
 * agent harness (PostToolUse verify / UserPromptSubmit supply hooks).
 *
 * Routes:
 *   POST /api/verify   { diff, project? }       -> Verdict
 *   GET  /api/context  ?project=&task=          -> ContextBundle
 *
 * WHY these live on the long-running web server: a cold `anatomia verify` CLI
 * reparses the whole project per call (multi-second to minutes), which is far
 * too slow for a per-edit / per-prompt harness hook. The web server already
 * holds the analyzed project warm in memory (ProjectManager caches getContext),
 * so these endpoints answer in sub-second after the first request. The hooks are
 * thin HTTP clients that skip silently when the server is not running.
 *
 * SRP: HTTP routing + body/query shaping only. Verify/context logic stays in
 * core.ts; context resolution in WebContextSource.
 */

import type { Hono } from "hono";
import { buildVerdict, buildContextBundle } from "../../../core.js";
import type { VerifyOptions } from "../../../core.js";
import type { WebContextSource } from "../context.js";

/**
 * Mount the warm supply/verify routes on `app`. `verifyOpts` (providers +
 * cardCache) makes /api/verify run the duplication gate against real distilled
 * cards (else hermetic mock). /api/context needs no providers (it uses the
 * already-detected domains from analyze).
 */
export function mountHarnessRoutes(app: Hono, source: WebContextSource, verifyOpts?: VerifyOptions): void {
  // POST /api/verify — run the 5-gate verify on a diff against a warm project.
  app.post("/api/verify", async (c) => {
    let body: { diff?: unknown; project?: unknown; targetPath?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON { diff, project? }" }, 400);
    }
    if (typeof body.diff !== "string" || !body.diff.trim()) {
      return c.json({ error: "missing 'diff' (non-empty string)" }, 400);
    }
    const project = typeof body.project === "string" ? body.project : undefined;
    let ctx;
    try {
      ctx = await source.resolve(project);
    } catch {
      return c.json({ error: `no such project "${project ?? ""}"` }, 404);
    }
    const targetPath = typeof body.targetPath === "string" ? body.targetPath : undefined;
    const verdict = await buildVerdict(ctx, body.diff, targetPath, verifyOpts);
    return c.json(verdict);
  });

  // GET /api/context?project=&task= — deterministic ContextBundle (supply).
  app.get("/api/context", async (c) => {
    const project = c.req.query("project");
    const task = c.req.query("task") ?? "analyze";
    let ctx;
    try {
      ctx = await source.resolve(project);
    } catch {
      return c.json({ error: `no such project "${project ?? ""}"` }, 404);
    }
    const bundle = await buildContextBundle(ctx, { task });
    return c.json(bundle);
  });
}
