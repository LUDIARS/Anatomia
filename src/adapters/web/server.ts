/**
 * src/adapters/web/server.ts — T32: Web viz HTTP server (Hono).
 *
 * Routes:
 *   GET /api/graph    — { nodes: CodeNode[], edges: Edge[] }
 *   GET /api/metrics  — NodeMetrics[]
 *   GET /api/mechanics — { mechanics: string[], cards: [] }
 *   GET /             — serves index.html (loaded from public/ at runtime)
 *
 * SRP: HTTP routing + static file serving only. Analysis via core.ts.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { Hono } from "hono";
import { computeMetrics } from "../../supply/metrics.js";
import type { AnalysisContext } from "../../core.js";
import type { CodeNode, Edge } from "../../types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WebServerOptions {
  ctx: AnalysisContext;
  /** HTTP port. Default 4200. */
  port?: number;
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
    // Fallback when running from source (ts-node / vitest) — file not at dist/
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

export function createApp(ctx: AnalysisContext): Hono {
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
    // Empty mechanic membership — adapters don't carry G3 mechanic data.
    const metrics = await computeMetrics(ctx.graph, new Map());
    return c.json(metrics);
  });

  // GET /api/mechanics
  app.get("/api/mechanics", (c) => {
    return c.json({ mechanics: [] as string[], cards: [] as unknown[] });
  });

  // GET / — serve index.html
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
  const { ctx, port = 4200 } = options;
  const app = createApp(ctx);

  // Dynamic import to avoid bundling @hono/node-server into tests.
  const { serve } = await import("@hono/node-server");
  serve({ fetch: app.fetch, port }, () => {
    console.log(`[anatomia/web] listening on http://localhost:${port}`);
  });
}
