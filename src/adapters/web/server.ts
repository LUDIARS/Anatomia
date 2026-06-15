/**
 * src/adapters/web/server.ts -- T32 + G8: Web viz HTTP server (Hono).
 *
 * Static routes (T32):
 *   GET /api/graph    -- { nodes: CodeNode[], edges: Edge[] }
 *   GET /api/metrics  -- NodeMetrics[]
 *   GET /api/domains -- { domains: string[], cards: [] }
 *   GET /             -- serves index.html
 *
 * Dynamic trace routes (G8):
 *   GET /api/trace/timeline -- TimelineData (T40)
 *   GET /api/trace/active   -- ActiveOverlay (T41)
 *   GET /api/trace/where    -- WhereLabel    (T42)
 *
 * SRP: HTTP routing + static file serving only. Analysis via core.ts.
 *      Trace shaping via src/dynamic/viz/.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { Hono } from "hono";
import { computeMetrics } from "../../supply/metrics.js";
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
  ctx: AnalysisContext;
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

function loadIndexHtml(): string {
  try {
    return readFileSync(join(__dirname, "public", "index.html"), "utf8");
  } catch {
    // Fallback when running from source (ts-node / vitest) -- file not at dist/
    try {
      return readFileSync(
        join(__dirname, "..", "..", "..", "src", "adapters", "web", "public", "index.html"),
        "utf8",
      );
    } catch {
      return "<html><body>Anatomia Web Viz (index.html not found)</body></html>";
    }
  }
}

// ---------------------------------------------------------------------------
// createApp
// ---------------------------------------------------------------------------

export function createApp(ctx: AnalysisContext, traceSource?: TraceSource): Hono {
  const trace: TraceSource = traceSource ?? new RecordedTraceSource([]);
  const app = new Hono();

  // GET /api/graph
  app.get("/api/graph", async (c) => {
    const nodes: CodeNode[] = await ctx.graph.allNodes();

    // Collect all edges by iterating adjacency via edgesFrom per node.
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

  // GET /api/metrics
  app.get("/api/metrics", async (c) => {
    // Empty domain membership -- adapters don't carry G3 domain data.
    const metrics = await computeMetrics(ctx.graph, new Map());
    return c.json(metrics);
  });

  // GET /api/domains
  app.get("/api/domains", (c) => {
    return c.json({ domains: [] as string[], cards: [] as unknown[] });
  });

  // GET /api/trace/timeline -- T40
  app.get("/api/trace/timeline", (c) => {
    const windowParam = c.req.query("window");
    const windowN = windowParam ? parseInt(windowParam, 10) : 60;
    const frames = trace.recentFrames(windowN);
    return c.json(buildTimeline(frames, windowN));
  });

  // GET /api/trace/active -- T41
  app.get("/api/trace/active", async (c) => {
    const activeZoneSet = trace.currentActiveZoneSet();
    const nodes: CodeNode[] = await ctx.graph.allNodes();
    return c.json(buildActiveOverlay(activeZoneSet, nodes));
  });

  // GET /api/trace/where -- T42
  app.get("/api/trace/where", (c) => {
    const current = trace.currentFrame();
    if (!current) {
      return c.json({ frameId: 0, domain: null, functionAnchorId: null, label: "no trace data", phase: null });
    }
    // Cards are not held in AnalysisContext (G3 not wired to web adapter).
    // Pass empty cards -- domain field will be null without card data.
    const result = buildWhere(current.frameId, trace.currentActiveZoneSet(), []);
    return c.json(result);
  });

  // GET / -- serve index.html
  app.get("/", (c) => {
    const html = loadIndexHtml();
    return c.html(html);
  });

  return app;
}

// ---------------------------------------------------------------------------
// startServer
// ---------------------------------------------------------------------------

export async function startServer(options: WebServerOptions): Promise<void> {
  const { ctx, port = 4200, traceSource } = options;
  const app = createApp(ctx, traceSource);

  // Dynamic import to avoid bundling @hono/node-server into tests.
  const { serve } = await import("@hono/node-server");
  serve({ fetch: app.fetch, port }, () => {
    console.log(`[anatomia/web] listening on http://localhost:${port}`);
  });
}