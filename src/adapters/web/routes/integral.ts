/**
 * src/adapters/web/routes/integral.ts — Integral-search + module routes.
 *
 * Routes:
 *   POST /api/integral { project?, entry:{ref,scope}, graph?, range?, judge? }
 *        → IntegralReport (Phase A deterministic; Phase B Sonnet judge when
 *          judge=true and a judge LLM is wired; Phase C path cache replays a
 *          prior judged report without re-calling Sonnet)
 *   GET  /api/projects/:id/modules
 *        → ModuleEvaluation (機能 partition + cohesion + misfits + modularity),
 *          served from the analyze-time artifact (no re-analysis on open)
 *
 * WHY warm: the deterministic search is cheap, but it needs the analyzed graph +
 * the module evaluation held warm (cold re-analysis is the multi-second hang the
 * panel used to suffer). The module evaluation is a fingerprint-keyed artifact so
 * a restart serves it from disk.
 *
 * SRP: HTTP shaping only. Search/judge/cache live in src/integral/, module
 * evaluation in src/modules/.
 */

import type { Hono } from "hono";
import { runIntegral } from "../../../integral/run.js";
import { emptySceneModel } from "../../../integral/scene.js";
import type { IntegralCache } from "../../../integral/cache.js";
import type { IntegralQuery, IntegralScope } from "../../../integral/types.js";
import { evaluateModulesFromGraph } from "../../../modules/evaluate.js";
import type { ModuleEvaluation } from "../../../modules/types.js";
import type { LLMClient } from "../../../domains/card.js";
import { runWithSession } from "../../../cache/session-context.js";
import type { WebContextSource } from "../context.js";

/** Dependencies for the integral route (judge LLM + path cache). */
export interface IntegralRouteDeps {
  /** Judge LLM (Sonnet). Absent → the judge cannot run; deterministic-only. */
  judgeLlm?: LLMClient;
  /** Resolved judge model id (folded into the path-cache key). */
  judgeModelId?: string;
  /** Persistent integral path cache (survives restarts when file/redis backed). */
  pathCache?: IntegralCache;
}

const SCOPES = new Set<IntegralScope>(["function", "domain", "scene"]);

/** Resolve + cache the analyze-time module evaluation for a project. */
function moduleEvalFor(source: WebContextSource, project?: string): Promise<ModuleEvaluation> {
  return source.cachedArtifact(project, "module-eval", async (ctx) => {
    const { evaluation } = await evaluateModulesFromGraph(ctx.graph, ctx.functions);
    return evaluation;
  });
}

export function mountIntegralRoutes(app: Hono, source: WebContextSource, deps: IntegralRouteDeps = {}): void {
  app.post("/api/integral", async (c) => {
    let body: {
      project?: unknown;
      entry?: { ref?: unknown; scope?: unknown };
      graph?: unknown;
      range?: unknown;
      judge?: unknown;
      session?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON { entry:{ref,scope}, range?, judge? }" }, 400);
    }
    const ref = body.entry?.ref;
    const scope = body.entry?.scope;
    if (typeof ref !== "string" || !ref.trim()) {
      return c.json({ error: "missing entry.ref (non-empty string)" }, 400);
    }
    if (typeof scope !== "string" || !SCOPES.has(scope as IntegralScope)) {
      return c.json({ error: "entry.scope must be one of function | domain | scene" }, 400);
    }
    const project = typeof body.project === "string" ? body.project : undefined;
    const query: IntegralQuery = {
      entry: { ref, scope: scope as IntegralScope },
      graph: (body.graph as IntegralQuery["graph"]) ?? undefined,
      range: (body.range as IntegralQuery["range"]) ?? undefined,
    };
    const judge = body.judge === true;

    let ctx;
    try {
      ctx = await source.resolve(project);
    } catch {
      return c.json({ error: `no such project "${project ?? ""}"` }, 404);
    }
    const [moduleEval, fingerprint] = await Promise.all([
      moduleEvalFor(source, project),
      source.fingerprint(project),
    ]);

    const session = typeof body.session === "string" ? body.session : undefined;
    const report = await runWithSession(session, () =>
      runIntegral(ctx, query, {
        scenes: emptySceneModel(),
        moduleEval,
        fingerprint,
        llm: judge ? deps.judgeLlm : undefined,
        modelId: deps.judgeModelId,
        cache: deps.pathCache,
      }),
    );
    return c.json(report);
  });

  app.get("/api/projects/:id/modules", async (c) => {
    const id = c.req.param("id");
    try {
      const evaluation = await moduleEvalFor(source, id);
      return c.json(evaluation);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }
  });
}
