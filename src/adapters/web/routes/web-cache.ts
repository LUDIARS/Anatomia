/**
 * src/adapters/web/routes/web-cache.ts — Prepare + serve the web-display cache.
 *
 * Routes (manager mode only — the panel always runs with a ProjectManager):
 *   POST /api/projects/:id/prepare-web-cache  ENQUEUE a background prepare → 202 {jobId}
 *   GET  /api/prepare-jobs                    queue snapshot (panel progress widget)
 *   GET  /api/projects/:id/web/manifest       index + stale flag (prepared?)
 *   GET  /api/projects/:id/web/:view          one prepared view (409 if absent)
 *   POST /api/projects/:id/web/search         LLM search over the prepared corpus
 *
 * Prepare is ASYNC: a full analyze+build takes minutes on a large repo, which
 * outran the browser's fetch timeout when the POST awaited it. It now enqueues a
 * job on a serial in-server queue (prepare-queue.ts) and returns immediately; the
 * panel polls /api/prepare-jobs to show queue state + phase + outcome.
 *
 * The panel renders ONLY from these prepared files: a missing view returns 409
 * so the panel shows an error + a "prepare" prompt instead of rendering nothing.
 * Search fails FAST when only the stub LLM is configured (no silent substring
 * fallback) — memory feedback_no_silent_fallback.
 *
 * SRP: HTTP shaping only. Building in web-cache/build.ts, persistence in
 * web-cache/store.ts, search in web-cache/search.ts, scheduling in prepare-queue.ts.
 */

import type { Hono } from "hono";
import type { ProjectManager } from "../../../project/manager.js";
import type { LLMClient } from "../../../domains/card.js";
import { buildWebCacheBundle } from "../../../web-cache/build.js";
import { writeWebCache, readWebManifest, readWebView } from "../../../web-cache/store.js";
import { PrepareQueue } from "../../../web-cache/prepare-queue.js";
import { WEB_VIEWS } from "../../../web-cache/types.js";
import type { WebViewName, SearchCorpus } from "../../../web-cache/types.js";
import { searchCorpus } from "../../../web-cache/search.js";
import { loadScenes, mergeSceneModel } from "../../../scenes/store.js";
import { scenesFromScreenGraph } from "../../../scenes/from-screens.js";
import { detectScreens } from "../../../screens/index.js";
import { sceneModelFromTraceFile } from "../../../dynamic/record/ingest.js";
import { sceneModelFromTrace, type SceneModel, type SceneRef } from "../../../integral/scene.js";
import type { TraceSource } from "../../../dynamic/viz/trace-source.js";
import type { AnalysisContext } from "../../../core.js";

/** Dependencies for the web-cache routes. */
export interface WebCacheRouteDeps {
  /** Required for all routes (returns 501 when null). */
  manager: ProjectManager | null;
  /** Haiku LLM for search. Absent / stub → search fails fast. */
  searchLlm?: LLMClient;
  /** Resolved search model id ("stub-llm" → no real key → search refused). */
  searchModelId?: string;
  /** Recorded-trace JSONL (ANATOMIA_TRACE_FILE) feeding the scene layer. */
  traceJsonl?: string;
  /** Live/recorded trace source feeding the scene layer. */
  traceSource?: TraceSource;
}

const VIEW_SET = new Set<WebViewName>(WEB_VIEWS);

/** Resolve the scene model for a prepare run: manual scenes override discovered scenes. */
async function resolveSceneModel(
  deps: WebCacheRouteDeps,
  repoPath: string,
  project: string,
  ctx: AnalysisContext,
): Promise<SceneModel> {
  const [manual, screenGraph] = await Promise.all([
    loadScenes(repoPath, project),
    detectScreens(ctx),
  ]);
  const screenScenes = scenesFromScreenGraph(screenGraph);
  let traceScenes: SceneRef[] = [];
  if (deps.traceJsonl) {
    traceScenes = sceneModelFromTraceFile(deps.traceJsonl, ctx.domains ?? []).scenes();
  } else if (deps.traceSource) {
    traceScenes = sceneModelFromTrace(deps.traceSource).scenes();
  }
  return mergeSceneModel(manual, [...screenScenes, ...traceScenes]);
}

export function mountWebCacheRoutes(app: Hono, deps: WebCacheRouteDeps): void {
  const { manager } = deps;

  // One serial prepare queue per server: a heavy analyze+build runs in the
  // background so the POST returns instantly (no fetch timeout on big repos),
  // and the panel polls /api/prepare-jobs to visualise progress. The runner is
  // injected here so the queue itself stays free of manager/HTTP deps.
  const queue = new PrepareQueue(async (projectId, setPhase) => {
    const project = manager!.get(projectId)!;
    setPhase("analyzing");
    const ctx = await manager!.getContext(projectId);
    const fingerprint = await manager!.fingerprint(projectId);
    const sceneModel = await resolveSceneModel(deps, project.rootPath, project.name, ctx);
    setPhase("building views");
    const bundle = await buildWebCacheBundle(ctx, { sceneModel });
    setPhase("writing");
    const preparedAt = new Date().toISOString();
    const manifest = await writeWebCache(
      manager!.cache.dirFor(project.id),
      project.id,
      fingerprint,
      bundle,
      preparedAt,
    );
    return { views: manifest.views.length, counts: manifest.counts };
  });

  // POST prepare-web-cache — ENQUEUE a background prepare and return at once.
  // Previously this awaited the whole build; on a large repo (KuzuSurvivors) that
  // outran the browser's fetch timeout. Now it returns 202 + a jobId the panel
  // tracks via /api/prepare-jobs; the serial worker does the real work.
  app.post("/api/projects/:id/prepare-web-cache", async (c) => {
    if (!manager) return c.json({ error: "web cache requires manager mode" }, 501);
    const id = c.req.param("id");
    let projectId: string;
    try {
      projectId = manager.resolveId(id);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }
    if (!manager.get(projectId)) return c.json({ error: `no such project "${id}"` }, 404);
    const job = queue.enqueue(projectId);
    return c.json({ jobId: job.id, projectId: job.projectId, state: job.state }, 202);
  });

  // GET prepare-jobs — the queue snapshot for the panel's progress widget.
  app.get("/api/prepare-jobs", (c) => {
    if (!manager) return c.json({ error: "web cache requires manager mode" }, 501);
    return c.json({ jobs: queue.jobs(), active: queue.active });
  });

  // GET web/manifest — prepared? + stale (source changed since prepare)?
  app.get("/api/projects/:id/web/manifest", async (c) => {
    if (!manager) return c.json({ error: "web cache requires manager mode" }, 501);
    const id = c.req.param("id");
    let projectId: string;
    try {
      projectId = manager.resolveId(id);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }
    const manifest = await readWebManifest(manager.cache.dirFor(projectId));
    if (!manifest) return c.json({ prepared: false });
    let stale = false;
    try {
      stale = (await manager.fingerprint(projectId)) !== manifest.fingerprint;
    } catch {
      /* leave stale=false when the fingerprint can't be computed */
    }
    return c.json({ prepared: true, ...manifest, stale });
  });

  // POST web/search — LLM search over the prepared corpus (fail-fast on stub).
  app.post("/api/projects/:id/web/search", async (c) => {
    if (!manager) return c.json({ error: "web cache requires manager mode" }, 501);
    if (!deps.searchLlm || deps.searchModelId === "stub-llm") {
      return c.json(
        {
          error:
            "search requires a real LLM. LUDIARS runs the claude CLI (claude -p, no API key) — " +
            "ensure `claude` is on PATH, or set ANATOMIA_LLM_BACKEND to a non-stub backend. " +
            "The offline stub does not support search (no substring fallback).",
        },
        501,
      );
    }
    const id = c.req.param("id");
    let projectId: string;
    try {
      projectId = manager.resolveId(id);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }
    let body: { query?: unknown };
    try {
      body = (await c.req.json()) as { query?: unknown };
    } catch {
      return c.json({ error: "body must be JSON { query }" }, 400);
    }
    const query = typeof body.query === "string" ? body.query : "";
    if (!query.trim()) return c.json({ error: "missing query (non-empty string)" }, 400);

    const env = await readWebView<SearchCorpus>(manager.cache.dirFor(projectId), "search-corpus");
    if (!env) return c.json({ error: "not-prepared", view: "search-corpus" }, 409);

    try {
      const outcome = await searchCorpus(env.data, query, deps.searchLlm);
      return c.json(outcome);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // GET web/:view — one prepared view, or 409 when not prepared.
  app.get("/api/projects/:id/web/:view", async (c) => {
    if (!manager) return c.json({ error: "web cache requires manager mode" }, 501);
    const id = c.req.param("id");
    const view = c.req.param("view") as WebViewName;
    if (!VIEW_SET.has(view)) return c.json({ error: `unknown view "${view}"` }, 404);
    let projectId: string;
    try {
      projectId = manager.resolveId(id);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }
    const env = await readWebView(manager.cache.dirFor(projectId), view);
    if (!env) return c.json({ error: "not-prepared", view }, 409);
    return c.json({ view, preparedAt: env.preparedAt, fingerprint: env.fingerprint, data: env.data });
  });
}
