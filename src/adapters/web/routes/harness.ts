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
import { runWithSession } from "../../../cache/session-context.js";
import { vgWrite } from "../../../obs/vestigium.js";

/**
 * Mount the warm supply/verify routes on `app`. `verifyOpts` (providers +
 * cardCache) makes /api/verify run the duplication gate against real distilled
 * cards (else hermetic mock). /api/context needs no providers (it uses the
 * already-detected domains from analyze).
 */
export function mountHarnessRoutes(app: Hono, source: WebContextSource, verifyOpts?: VerifyOptions): void {
  // POST /api/verify — run the 5-gate verify on a diff against a warm project.
  app.post("/api/verify", async (c) => {
    let body: { diff?: unknown; project?: unknown; targetPath?: unknown; session?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON { diff, project? }" }, 400);
    }
    if (typeof body.diff !== "string" || !body.diff.trim()) {
      return c.json({ error: "missing 'diff' (non-empty string)" }, 400);
    }
    const diff = body.diff;
    const project = typeof body.project === "string" ? body.project : undefined;
    let ctx;
    try {
      ctx = await source.resolve(project);
    } catch {
      return c.json({ error: `no such project "${project ?? ""}"` }, 404);
    }
    const targetPath = typeof body.targetPath === "string" ? body.targetPath : undefined;
    // Tag cache events produced by this verify with the caller's session (e.g. the
    // Lictor/Concordia session id) so cache-stats can report a per-session slice.
    const session = typeof body.session === "string" ? body.session : undefined;
    const verdict = await runWithSession(session, () => buildVerdict(ctx, diff, targetPath, verifyOpts));
    // 解析ログ: verify の合否とゲート内訳を Vg へ (diff の中身は出さない)。
    const failed = verdict.gates.filter((g) => !g.pass).map((g) => g.gate);
    vgWrite(verdict.pass ? "info" : "warn", `anatomia verify ${verdict.pass ? "pass" : "fail"}`, {
      project: project ?? "", session, pass: verdict.pass, gates: verdict.gates.length, failed,
    });
    return c.json(verdict);
  });

  // GET /api/context?project=&task= — deterministic ContextBundle (supply).
  app.get("/api/context", async (c) => {
    const project = c.req.query("project");
    const task = c.req.query("task") ?? "analyze";
    const session = c.req.query("session");
    let ctx;
    try {
      ctx = await source.resolve(project);
    } catch {
      return c.json({ error: `no such project "${project ?? ""}"` }, 404);
    }
    const bundle = await runWithSession(session, () => buildContextBundle(ctx, { task }));
    // 解析ログ: supply で解決したドメイン/ルール/手本の件数を Vg へ (中身は出さない)。
    vgWrite("info", "anatomia supply", {
      project: project ?? "", task, session,
      domains: bundle.existingDomains.length,
      rules: bundle.applicableRules.length,
      exemplars: bundle.exemplars.length,
    });
    return c.json(bundle);
  });
}
