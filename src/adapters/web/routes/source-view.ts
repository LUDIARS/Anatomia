/**
 * src/adapters/web/routes/source-view.ts — open a domain's implementation in
 * Tela's dedicated source viewer.
 *
 * Routes:
 *   GET  /api/projects/:id/source-view/candidates?domain=<name>
 *     → { domain, candidates: [{ anchor, name, enclosingType, file, line }] }
 *   GET  /api/projects/:id/source-view/status
 *     → { configured, local, message? } — lets the panel explain up front why
 *       the button will not work (unconfigured viewer, remote client).
 *   GET  /api/projects/:id/source-view/content?file=<repo-relative>&line=<n>
 *     → { file, line, lineCount, stale, start, lines[], enclosing } — the web view
 *       (bounded window + enclosing function + callers / callees).
 *   POST /api/projects/:id/source-view/launch  { file, line, acceptStale? }
 *     → { ok: true, file, line, stale } | { ok: false, reason, message, file?, line? }
 *
 * Every refusal names the file and line and a next step, so the user can still
 * find the code (re-analyze, open the current file anyway, use the server PC).
 * A stale file (changed after analysis) is not opened until the user confirms
 * with `acceptStale`.
 *
 * SRP: HTTP shaping. Validation, launching and candidate derivation live in the
 * source-view-*.ts modules next to this folder.
 *
 * @spec Tela source viewer launch
 */

import type { Context, Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { WebContextSource } from "../context.js";
import { analyzedContentHash, sourceViewCandidates } from "../source-view-candidates.js";
import { buildSourceViewContent } from "../source-view-content.js";
import { launchSourceViewer, loadSourceViewerConfig, type SpawnLike } from "../source-view-launch.js";
import { classifyLaunchRequest, remoteLaunchMessage, type LaunchOrigin } from "../source-view-request.js";
import { resolveSourceTarget } from "../source-view-target.js";

export interface SourceViewRouteDeps {
  /** Injected for tests; defaults to node:child_process spawn. */
  spawn?: SpawnLike;
  /** Injected for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Injected for tests; defaults to the node-server socket address. */
  remoteAddress?: (c: Context) => string | undefined;
}

function socketAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

export function mountSourceViewRoutes(app: Hono, source: WebContextSource, deps: SourceViewRouteDeps = {}): void {
  const origin = (c: Context): LaunchOrigin => classifyLaunchRequest({
    remoteAddress: (deps.remoteAddress ?? socketAddress)(c),
    header: (name) => c.req.header(name),
  });

  app.get("/api/projects/:id/source-view/candidates", async (c) => {
    const domain = (c.req.query("domain") ?? "").trim();
    if (!domain) return c.json({ ok: false, reason: "invalid-request", message: "domain を指定してください。" }, 400);
    let ctx;
    try {
      ctx = await source.resolve(c.req.param("id"));
    } catch {
      return c.json({ ok: false, reason: "unknown-project", message: `プロジェクト "${c.req.param("id")}" がありません。` }, 404);
    }
    const result = sourceViewCandidates(ctx, domain);
    return c.json(result, result.ok ? 200 : 404);
  });

  app.get("/api/projects/:id/source-view/content", async (c) => {
    const file = c.req.query("file") ?? "";
    const line = Number(c.req.query("line") ?? "1");
    let ctx;
    try {
      ctx = await source.resolve(c.req.param("id"));
    } catch {
      return c.json({ ok: false, reason: "unknown-project", message: `プロジェクト "${c.req.param("id")}" がありません。` }, 404);
    }
    const resolved = await resolveSourceTarget({
      repoPath: ctx.repoPath,
      analyzedFiles: ctx.files.map((entry) => entry.path),
      file,
      line,
      analyzedContentHash: analyzedContentHash(ctx, file),
    });
    if (!resolved.ok) return c.json({ ...resolved, file, line }, 422);
    const content = await buildSourceViewContent(ctx, resolved.target);
    return content.ok ? c.json({ ok: true, ...content.content }) : c.json({ ...content, file, line }, 422);
  });

  app.get("/api/projects/:id/source-view/status", async (c) => {
    const config = await loadSourceViewerConfig(deps.env);
    const where = origin(c);
    const message = !config.ok ? config.message : where.local ? undefined : remoteLaunchMessage(where.reason);
    return c.json({ configured: config.ok, local: where.local, ...(message ? { message } : {}) });
  });

  app.post("/api/projects/:id/source-view/launch", async (c) => {
    let body: { file?: unknown; line?: unknown; acceptStale?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, reason: "invalid-request", message: "JSON の本文で file と line を指定してください。" }, 400);
    }
    const echo = {
      ...(typeof body.file === "string" ? { file: body.file } : {}),
      ...(typeof body.line === "number" ? { line: body.line } : {}),
    };

    const where = origin(c);
    if (!where.local) {
      return c.json({ ok: false, reason: where.reason, message: remoteLaunchMessage(where.reason), ...echo }, 403);
    }

    let ctx;
    try {
      ctx = await source.resolve(c.req.param("id"));
    } catch {
      return c.json({ ok: false, reason: "unknown-project", message: `プロジェクト "${c.req.param("id")}" がありません。`, ...echo }, 404);
    }

    const resolved = await resolveSourceTarget({
      repoPath: ctx.repoPath,
      analyzedFiles: ctx.files.map((entry) => entry.path),
      file: body.file,
      line: body.line,
      analyzedContentHash: typeof body.file === "string" ? analyzedContentHash(ctx, body.file) : undefined,
    });
    if (!resolved.ok) return c.json({ ...resolved, ...echo }, 422);
    const { target } = resolved;
    if (target.stale && body.acceptStale !== true) {
      return c.json({
        ok: false,
        reason: "stale",
        message: "解析後にファイルが変更されています。現在の内容のまま開くか、再解析してから選び直してください。",
        file: target.file,
        line: target.line,
      }, 409);
    }

    const config = await loadSourceViewerConfig(deps.env);
    if (!config.ok) return c.json({ ...config, file: target.file, line: target.line }, 503);

    const launched = await launchSourceViewer(config.config, target, deps.spawn);
    if (!launched.ok) return c.json({ ...launched, file: target.file, line: target.line }, 500);
    return c.json({ ok: true, file: target.file, line: target.line, stale: target.stale });
  });
}
