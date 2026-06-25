/**
 * src/adapters/web/server.ts -- Web viz HTTP server (Hono).
 *
 * Static routes:
 *   GET /api/graph     -- { nodes: CodeNode[], edges: Edge[] }   (?project=<id>)
 *   GET /api/metrics   -- NodeMetrics[]                          (?project=<id>)
 *   GET /api/domains   -- { domains: string[], cards: [] }       (?project=<id>)
 *   GET /api/cache-stats -- { enabled, logPath?, report? }       (A-3 cache hit rate)
 *   POST /api/cost-feed  -- ingest cross-service cost summaries     (other services PUSH)
 *   GET  /api/cost-feed  -- aggregated cross-service cost report    (panel)
 *   POST /api/verify   -- { diff, project? } -> Verdict           (warm harness verify hook)
 *   GET  /api/context  -- ?project=&task= -> ContextBundle        (warm harness supply hook)
 *   GET /              -- serves index.html (management panel SPA)
 *
 * Project management routes (manager mode only):
 *   GET    /api/projects               list + selected
 *   POST   /api/projects               add + analyze { name, rootPath }
 *   DELETE /api/projects/:id           remove
 *   POST   /api/projects/:id/analyze   (re)analyze
 *
 * Per-project data routes:
 *   GET /api/projects/:id/summary     counts
 *   GET /api/projects/:id/hotspots    top-N by coupling/complexity
 *   GET /api/projects/:id/spec-links  code↔spec links
 *   GET /api/projects/:id/domains     domain detection results
 *   GET /api/projects/:id/vis-data    vis-network data (shared with export.ts)
 *   GET /api/projects/:id/branch-diff branch-diff function delta (?base=<ref>)
 *   GET /api/projects/:id/branches    base refs for the branch-diff selector
 *   GET /api/projects/:id/domain-view per-domain focus + spec-derived JP descriptions
 *   GET /api/projects/:id/access-patterns heuristic singleton/locator/facade + accessor domains
 *
 * Dynamic trace routes (G8):
 *   GET /api/trace/timeline -- TimelineData (T40)
 *   GET /api/trace/active   -- ActiveOverlay (T41)
 *   GET /api/trace/where    -- WhereLabel    (T42)
 *
 * Project-awareness: createApp accepts either a bare AnalysisContext (legacy
 * single-project mode) or a ProjectManager (multi-project). In legacy mode
 * mutation routes return 501; all read routes use the single context.
 *
 * SRP: HTTP routing + static file serving only. Analysis via core.ts /
 *      ProjectManager. Route groups in src/adapters/web/routes/.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { Hono } from "hono";
import { computeMetrics } from "../../supply/metrics.js";
import { ProjectManager } from "../../project/manager.js";
import { webContextSourceFrom } from "./context.js";
import { mountProjectRoutes } from "./routes/projects.js";
import { mountAnalysisRoutes } from "./routes/analysis.js";
import { mountCacheRoute } from "./routes/cache.js";
import { mountCostRoute } from "./routes/cost.js";
import { mountHarnessRoutes } from "./routes/harness.js";
import { mountBranchRoutes } from "./routes/branch.js";
import { mountDomainViewRoute } from "./routes/domain-view.js";
import { mountIntegralRoutes, type IntegralRouteDeps } from "./routes/integral.js";
import { mountPatternRoutes } from "./routes/patterns.js";
import { mountWebCacheRoutes } from "./routes/web-cache.js";
import { mountAdjustRoutes } from "./routes/adjust.js";
import { resolveIdleMs, checkIntervalMs, shouldShutdown } from "./idle.js";
import { resolveProviders, envConfig } from "../../providers/index.js";
import { generateCard } from "../../domains/card.js";
import type { DomainCard } from "../../domains/card.js";
import type { CachedIntegral } from "../../integral/cache.js";
import { resolveCacheStore } from "../../cache/resolve.js";
import { instrumentStore } from "../../cache/instrumented.js";
import { resolveTranscript } from "../../cache/transcript.js";
import { currentSession } from "../../cache/session-context.js";
import type { VerifyOptions } from "../../core.js";
import type { AnalysisContext } from "../../core.js";
import type { CodeNode, Edge } from "../../types.js";
import { buildTimeline } from "../../dynamic/viz/timeline.js";
import { buildActiveOverlay } from "../../dynamic/viz/active.js";
import { buildWhere } from "../../dynamic/viz/where.js";
import { RecordedTraceSource } from "../../dynamic/viz/trace-source.js";
import type { TraceSource } from "../../dynamic/viz/trace-source.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WebServerOptions {
  /** A single AnalysisContext (legacy) or a ProjectManager (multi-project). */
  ctx: AnalysisContext | ProjectManager;
  /** HTTP port. Default 4200. */
  port?: number;
  /**
   * Optional live or recorded trace source for dynamic viz (G8).
   * Defaults to an empty RecordedTraceSource when not provided.
   */
  traceSource?: TraceSource;
}

// ---------------------------------------------------------------------------
// index.html loader (read once at module init time)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Read a file from the panel's `public/` dir. Tries the dist-relative location
 * first, then the src tree (tsc does not copy public/), so the same server runs
 * from either. Returns null when absent.
 */
function loadPublicAsset(name: string): string | null {
  const candidates = [
    join(__dirname, "public", name),
    join(__dirname, "..", "..", "..", "src", "adapters", "web", "public", name),
  ];
  for (const path of candidates) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      // try next candidate
    }
  }
  return null;
}

function loadIndexHtml(): string {
  return (
    loadPublicAsset("index.html") ??
    "<html><body>Anatomia Web Viz (index.html not found)</body></html>"
  );
}

// ---------------------------------------------------------------------------
// createApp
// ---------------------------------------------------------------------------

export function createApp(
  src: AnalysisContext | ProjectManager,
  traceSource?: TraceSource,
  verifyOpts?: VerifyOptions,
  onAccess?: () => void,
): Hono {
  const source = webContextSourceFrom(src);
  const manager = src instanceof ProjectManager ? src : null;
  const trace: TraceSource = traceSource ?? new RecordedTraceSource([]);
  const app = new Hono();

  // ── Access tracking (warm-server idle shutdown) ──────────────────────────
  // Registered first so it wraps every route; notifies startServer of activity
  // so an idle warm daemon can self-terminate (next hook call re-spawns it).
  if (onAccess) {
    app.use("*", async (_c, next) => {
      onAccess();
      await next();
    });
  }

  // ── Project management routes ────────────────────────────────────────────
  // onAfterAnalyze: fire-and-forget card pre-warm so subsequent verify/context
  // calls get LLM cache hits instead of cold distillation on first use.
  const _prewarmVerifyOpts = resolveWebVerifyOpts();
  mountProjectRoutes(app, source, manager, (ctx) => {
    const pr = _prewarmVerifyOpts.providers;
    const cc = _prewarmVerifyOpts.cardCache;
    if (!pr) return;  // no LLM configured → skip pre-warm
    void (async () => {
      for (const d of ctx.domains ?? []) {
        if (d.implementors.length === 0) continue;
        try {
          await generateCard(d.domain, d, ctx.graph, pr.llm, cc, {
            modelId: pr.llmModelId,
          });
        } catch {
          // pre-warm failure is non-fatal
        }
      }
    })();
  });

  // ── Per-project analysis routes ──────────────────────────────────────────
  mountAnalysisRoutes(app, source);

  // ── Branch-diff analysis route (diff-only view over the full analysis) ────
  mountBranchRoutes(app, source);

  // ── Domain-view route (per-domain focus + spec-derived JP descriptions) ───
  mountDomainViewRoute(app, source);

  // ── Integral-search + module routes (3-layer scoped retrieval + 機能 eval) ─
  // The trace source feeds the scene layer (局面) when it holds frames.
  mountIntegralRoutes(app, source, { ...resolveIntegralDeps(), traceSource: trace });

  // ── Access-pattern route (heuristic singleton/locator/facade + accessors) ──
  mountPatternRoutes(app, source);

  // ── Prepared web-display cache: build + serve every view + LLM search ──────
  // The panel renders ONLY from these prepared files (no cache → 409 → prompt).
  const aux = resolveAuxDeps();
  mountWebCacheRoutes(app, {
    manager,
    searchLlm: aux.searchLlm,
    searchModelId: aux.searchModelId,
    traceJsonl: aux.traceJsonl,
    traceSource: trace,
  });

  // ── Adjustment routes: domain/module/scene CRUD + granularity retune ───────
  mountAdjustRoutes(app, {
    manager,
    retuneLlm: aux.retuneLlm,
    retuneModelId: aux.retuneModelId,
  });

  // ── Global LLM-cache stats route (A-3 measurement) ───────────────────────
  mountCacheRoute(app);

  // ── Cross-service cost-feed routes (other services PUSH cost summaries) ────
  mountCostRoute(app);

  // ── Warm supply/verify routes for the agent harness (hooks) ──────────────
  mountHarnessRoutes(app, source, verifyOpts);

  // ── Legacy data routes (kept for backward compat; also used by old tests) ─

  // GET /api/graph (?project=<id>)
  app.get("/api/graph", async (c) => {
    const ctx = await source.resolve(c.req.query("project"));
    const nodes: CodeNode[] = await ctx.graph.allNodes();

    const edgeMap = new Map<string, Edge>();
    for (const node of nodes) {
      const edges = await ctx.graph.edgesFrom(node.id);
      for (const e of edges) {
        const key = `${e.from}|${e.to}|${e.kind}`;
        if (!edgeMap.has(key)) edgeMap.set(key, e);
      }
    }

    return c.json({ nodes, edges: Array.from(edgeMap.values()) });
  });

  // GET /api/metrics (?project=<id>)
  app.get("/api/metrics", async (c) => {
    const ctx = await source.resolve(c.req.query("project"));
    const metrics = await computeMetrics(ctx.graph, new Map());
    return c.json(metrics);
  });

  // GET /api/domains (?project=<id>)
  app.get("/api/domains", async (c) => {
    const ctx = await source.resolve(c.req.query("project"));
    const domains = (ctx.domains ?? [])
      .filter((m) => m.implementors.length > 0)
      .map((m) => m.domain);
    return c.json({ domains, cards: [] as unknown[] });
  });

  // ── Dynamic trace routes (G8) ────────────────────────────────────────────

  // GET /api/trace/timeline -- T40
  app.get("/api/trace/timeline", (c) => {
    const windowParam = c.req.query("window");
    const windowN = windowParam ? parseInt(windowParam, 10) : 60;
    const frames = trace.recentFrames(windowN);
    return c.json(buildTimeline(frames, windowN));
  });

  // GET /api/trace/active -- T41
  app.get("/api/trace/active", async (c) => {
    const ctx = await source.resolve(c.req.query("project"));
    const activeZoneSet = trace.currentActiveZoneSet();
    const nodes: CodeNode[] = await ctx.graph.allNodes();
    return c.json(buildActiveOverlay(activeZoneSet, nodes));
  });

  // GET /api/trace/where -- T42
  app.get("/api/trace/where", (c) => {
    const current = trace.currentFrame();
    if (!current) {
      return c.json({
        frameId: 0,
        domain: null,
        functionAnchorId: null,
        label: "no trace data",
        phase: null,
      });
    }
    const result = buildWhere(
      current.frameId,
      trace.currentActiveZoneSet(),
      [],
    );
    return c.json(result);
  });

  // GET / -- serve management panel SPA (index.html)
  app.get("/", (c) => {
    const html = loadIndexHtml();
    return c.html(html);
  });

  // Pure panel logic, loaded by index.html as ES modules (and unit-tested).
  for (const asset of ["domain-view-logic.js", "web-views-logic.js"]) {
    app.get(`/${asset}`, (c) => {
      const js = loadPublicAsset(asset);
      if (js == null) return c.text(`// ${asset} not found`, 404);
      return c.body(js, 200, { "content-type": "text/javascript; charset=utf-8" });
    });
  }

  return app;
}

// ---------------------------------------------------------------------------
// startServer
// ---------------------------------------------------------------------------

export async function startServer(options: WebServerOptions): Promise<void> {
  const { ctx, port = 4200, traceSource } = options;

  // Idle self-shutdown: the warm daemon exits after a window with no HTTP
  // access (default 3h, ANATOMIA_IDLE_SHUTDOWN_MS; <=0 disables). The harness
  // hook re-spawns it on the next supply/verify, so this just reclaims a daemon
  // that has been sitting unused.
  const idleMs = resolveIdleMs();
  let lastAccess = Date.now();
  const app = createApp(ctx, traceSource, resolveWebVerifyOpts(), () => {
    lastAccess = Date.now();
  });

  const { serve } = await import("@hono/node-server");
  serve({ fetch: app.fetch, port }, () => {
    console.log(`[anatomia/web] listening on http://localhost:${port}`);
    if (idleMs > 0) {
      console.log(`[anatomia/web] idle shutdown after ${Math.round(idleMs / 60000)}min of no access`);
    }
  });

  if (idleMs > 0) {
    const timer = setInterval(() => {
      if (shouldShutdown(lastAccess, Date.now(), idleMs)) {
        console.log(`[anatomia/web] idle for ${Math.round(idleMs / 60000)}min — shutting down`);
        process.exit(0);
      }
    }, checkIntervalMs(idleMs));
    // Don't let the idle timer itself keep the event loop alive.
    timer.unref?.();
  }
}

/**
 * Resolve the integral route's deps: a Sonnet judge LLM (the scope-judging agent
 * runs inside Anatomia, so it works headless from HTTP, not only inside an IDE)
 * and a persistent path cache (file/redis-backed via resolveCacheStore, so a
 * judged exploration survives restarts — the design's Phase C). The judge model
 * defaults to Sonnet (cheaper than the Opus card distiller) and is overridable.
 */
function resolveIntegralDeps(): IntegralRouteDeps {
  const judgeModel = process.env["ANATOMIA_INTEGRAL_JUDGE_MODEL"] || "claude-sonnet-4-6";
  const providers = resolveProviders({ ...envConfig(), llmModel: judgeModel });
  const pathCache = resolveCacheStore<CachedIntegral>();
  return {
    judgeLlm: providers.llm,
    judgeModelId: providers.llmModelId,
    pathCache,
    traceJsonl: readTraceFile(),
  };
}

/**
 * A recorded game trace (ANATOMIA_TRACE_FILE) lights up the scene layer on the
 * warm server without a live transport. Read once at wiring time; a missing /
 * unreadable file just leaves scenes empty (graceful).
 */
function readTraceFile(): string | undefined {
  const traceFile = process.env["ANATOMIA_TRACE_FILE"];
  if (!traceFile || !traceFile.trim()) return undefined;
  try {
    return readFileSync(traceFile.trim(), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Resolve the auxiliary LLM deps for the web-cache + adjustment routes: a Haiku
 * client for search (free-text → ranked results) and a (Sonnet) client for the
 * retune granularity flow. Both fail fast at the route when only the stub LLM is
 * configured (no API key) — never a silent substring/no-op fallback.
 */
function resolveAuxDeps(): {
  searchLlm: ReturnType<typeof resolveProviders>["llm"];
  searchModelId: string;
  retuneLlm: ReturnType<typeof resolveProviders>["llm"];
  retuneModelId: string;
  traceJsonl: string | undefined;
} {
  const searchModel = process.env["ANATOMIA_SEARCH_MODEL"] || "claude-haiku-4-5";
  const searchP = resolveProviders({ ...envConfig(), llmModel: searchModel });
  const retuneModel = process.env["ANATOMIA_RETUNE_MODEL"] || "claude-sonnet-4-6";
  const retuneP = resolveProviders({ ...envConfig(), llmModel: retuneModel });
  return {
    searchLlm: searchP.llm,
    searchModelId: searchP.llmModelId,
    retuneLlm: retuneP.llm,
    retuneModelId: retuneP.llmModelId,
    traceJsonl: readTraceFile(),
  };
}

/**
 * Resolve verify options (providers + instrumented card cache) from the
 * environment so `anatomia web` runs /api/verify with REAL distilled cards (and
 * records cache hit/miss) — mirrors the MCP server's main(). With no API key the
 * stub LLM is used; with ANATOMIA_CACHE_LOG set, card-cache gets are recorded.
 */
function resolveWebVerifyOpts(): VerifyOptions {
  const obs = resolveTranscript();
  // Tag every cache/LLM event with the per-request session id when a harness route
  // set one (runWithSession), else the process-global id. This is what splits the
  // shared warm server's events back into per-terminal-session slices.
  const sessionTag = () => currentSession() ?? obs.session;
  const providers = resolveProviders(undefined, {
    onUsage: (usage) =>
      obs.transcript.record({
        kind: "llm",
        ts: Date.now(),
        session: sessionTag(),
        model: providers.llmModelId,
        usage,
      }),
  });
  const base = resolveCacheStore<DomainCard>();
  const cardCache = obs.enabled
    ? instrumentStore(base, { ns: "card", transcript: obs.transcript, session: sessionTag, model: providers.llmModelId }).store
    : base;
  if (obs.enabled) {
    console.error(`[anatomia/web] verify cache measurement ON -> ${process.env["ANATOMIA_CACHE_LOG"]}`);
  }
  return { providers, cardCache };
}
