/**
 * src/adapters/web/server.ts -- T32 + G8 + multi-project: Web viz HTTP server (Hono).
 *
 * Static routes (T32):
 *   GET /api/graph     -- { nodes: CodeNode[], edges: Edge[] }   (?project=<id>)
 *   GET /api/metrics   -- NodeMetrics[]                          (?project=<id>)
 *   GET /api/domains   -- { domains: string[], cards: [] }       (?project=<id>)
 *   GET /api/projects  -- { projects: Project[], selected }      (manager mode)
 *   GET /              -- serves index.html (with a project dropdown)
 *
 * Dynamic trace routes (G8):
 *   GET /api/trace/timeline -- TimelineData (T40)
 *   GET /api/trace/active   -- ActiveOverlay (T41)
 *   GET /api/trace/where    -- WhereLabel    (T42)
 *
 * Project-awareness: createApp accepts either a bare AnalysisContext (legacy
 * single-project mode -- /api/projects returns just that one, ?project is
 * ignored) or a ProjectManager (the data routes resolve ?project=<id>, default
 * = selected; /api/projects lists the registry).
 *
 * SRP: HTTP routing + static file serving only. Analysis via core.ts /
 *      ProjectManager. Trace shaping via src/dynamic/viz/.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { Hono } from "hono";
import { computeMetrics } from "../../supply/metrics.js";
import { ProjectManager } from "../../project/manager.js";
import type { AnalysisContext } from "../../core.js";
import type { Project } from "../../project/types.js";
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

function loadIndexHtml(): string {
  try {
    return readFileSync(join(__dirname, "public", "index.html"), "utf8");
  } catch {
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
// Context resolution (single-context vs ProjectManager)
// ---------------------------------------------------------------------------

interface WebContextSource {
  /** Resolve a context for an optional ?project=<id>. */
  resolve(projectId?: string): Promise<AnalysisContext>;
  /** List registered projects (single entry in legacy mode). */
  projects(): Project[];
  /** Selected/default project id (or null). */
  selected(): string | null;
}

function webContextSourceFrom(src: AnalysisContext | ProjectManager): WebContextSource {
  if (src instanceof ProjectManager) {
    return {
      resolve: (projectId?: string) => src.getContext(projectId),
      projects: () => src.list(),
      selected: () => src.selected,
    };
  }
  // Legacy single context: synthesize a one-entry registry view.
  const single: Project = {
    id: "default",
    name: "default",
    rootPath: src.repoPath,
    addedAt: "",
  };
  return {
    resolve: async () => src,
    projects: () => [single],
    selected: () => "default",
  };
}

// ---------------------------------------------------------------------------
// createApp
// ---------------------------------------------------------------------------

export function createApp(
  src: AnalysisContext | ProjectManager,
  traceSource?: TraceSource,
): Hono {
  const source = webContextSourceFrom(src);
  const trace: TraceSource = traceSource ?? new RecordedTraceSource([]);
  const app = new Hono();

  // GET /api/projects -- registry list + selected id.
  app.get("/api/projects", (c) => {
    return c.json({ projects: source.projects(), selected: source.selected() });
  });

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
      return c.json({ frameId: 0, domain: null, functionAnchorId: null, label: "no trace data", phase: null });
    }
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

  const { serve } = await import("@hono/node-server");
  serve({ fetch: app.fetch, port }, () => {
    console.log(`[anatomia/web] listening on http://localhost:${port}`);
  });
}