/**
 * src/adapters/web/routes/analysis.ts — Per-project analysis data routes.
 *
 * Routes:
 *   GET /api/projects/:id/summary    file/function/node/edge/domain/link counts
 *   GET /api/projects/:id/hotspots   top-N functions by coupling + complexity
 *   GET /api/projects/:id/spec-links code↔spec links with clause metadata
 *   GET /api/projects/:id/domains    detected domains + violation counts
 *   GET /api/projects/:id/vis-data   vis-network ready graph data (shared with export)
 *
 * All routes resolve the AnalysisContext through WebContextSource and return
 * 404 when the project id is unknown.
 *
 * SRP: HTTP routing + data shaping. Metrics/graph/domain/spec logic stays in
 * their own modules; vis-data building is delegated to vis-data.ts.
 */

import { relative } from "node:path";
import type { Hono } from "hono";
import { computeMetrics } from "../../../supply/metrics.js";
import { buildVisData } from "../vis-data.js";
import type { WebContextSource } from "../context.js";
import type { AnchorId } from "../../../types.js";

/** Number of hotspot rows returned. */
const TOP_N = 20;

/**
 * Mount all per-project analysis routes on `app`.
 *
 * @param app    Hono application.
 * @param source Context source used to resolve project contexts.
 */
export function mountAnalysisRoutes(app: Hono, source: WebContextSource): void {
  // ── summary ───────────────────────────────────────────────────────────────

  app.get("/api/projects/:id/summary", async (c) => {
    const id = c.req.param("id");
    let ctx;
    try {
      ctx = await source.resolve(id);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }

    const nodes = await ctx.graph.allNodes();
    let edgeCount = 0;
    for (const n of nodes) {
      const edges = await ctx.graph.edgesFrom(n.id);
      edgeCount += edges.length;
    }

    return c.json({
      id,
      files: ctx.files.length,
      functions: ctx.functions.length,
      nodes: nodes.length,
      edges: edgeCount,
      domains: (ctx.domains ?? []).length,
      links: (ctx.links ?? []).length,
    });
  });

  // ── hotspots ──────────────────────────────────────────────────────────────

  app.get("/api/projects/:id/hotspots", async (c) => {
    const id = c.req.param("id");
    let ctx;
    try {
      ctx = await source.resolve(id);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }

    const membershipMap = new Map<string, AnchorId[]>();
    for (const d of ctx.domains ?? []) {
      membershipMap.set(d.domain, d.implementors);
    }
    const metrics = await computeMetrics(ctx.graph, membershipMap);
    const nodes = await ctx.graph.allNodes();
    const nodeById = new Map(nodes.map((n) => [n.id, n]));

    const sorted = [...metrics]
      .sort((a, b) => b.coupling - a.coupling || b.cyclomatic - a.cyclomatic)
      .slice(0, TOP_N);

    const hotspots = sorted.map((m) => {
      const node = nodeById.get(m.anchor);
      const relPath = node
        ? (() => {
            try {
              return relative(ctx.repoPath, node.sourceRange.filePath).replace(
                /\\/g,
                "/",
              );
            } catch {
              return node.sourceRange.filePath;
            }
          })()
        : "";
      return {
        anchor: m.anchor,
        name: node?.name ?? m.anchor,
        file: relPath,
        line: node?.sourceRange.start.line ?? 0,
        coupling: m.coupling,
        cyclomatic: m.cyclomatic,
        fanIn: m.fanIn,
        fanOut: m.fanOut,
        domainOverlap: m.domainOverlap,
        crossDomainDepth: m.crossDomainDepth,
      };
    });

    return c.json(hotspots);
  });

  // ── spec-links ────────────────────────────────────────────────────────────

  app.get("/api/projects/:id/spec-links", async (c) => {
    const id = c.req.param("id");
    let ctx;
    try {
      ctx = await source.resolve(id);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }

    const links = ctx.links ?? [];
    const clauseById = new Map(
      (ctx.specClauses ?? []).map((cl) => [cl.id, cl]),
    );
    const nodes = await ctx.graph.allNodes();
    const nameById = new Map(nodes.map((n) => [n.id, n.name]));

    const items = links.map((link) => {
      const clause = clauseById.get(link.to);
      return {
        from: link.from,
        fromName: nameById.get(link.from) ?? link.from,
        to: link.to,
        clauseHeading: clause?.heading ?? link.to,
        clauseFile: clause?.sourceFile ?? "",
        confidence: link.confidence,
        evidence: link.evidence,
        ratified: link.ratified ?? false,
      };
    });

    return c.json(items);
  });

  // ── domains ───────────────────────────────────────────────────────────────

  app.get("/api/projects/:id/domains", async (c) => {
    const id = c.req.param("id");
    let ctx;
    try {
      ctx = await source.resolve(id);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }

    const items = (ctx.domains ?? []).map((d) => ({
      domain: d.domain,
      implementorCount: d.implementors.length,
      conforms: d.conforms,
      violationCount: d.violations.length,
    }));

    return c.json(items);
  });

  // ── vis-data ──────────────────────────────────────────────────────────────

  /**
   * Pre-built vis-network data (same structure as the static export).
   * The browser uses this directly to init vis.Network without server-side
   * HTML injection — same buildVisData() call, shared with export.ts.
   */
  app.get("/api/projects/:id/vis-data", async (c) => {
    const id = c.req.param("id");
    let ctx;
    try {
      ctx = await source.resolve(id);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }

    const data = await buildVisData(ctx);
    return c.json(data);
  });
}
