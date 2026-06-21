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
import { buildReview } from "../../../review/index.js";
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
    try {
      // Served from the persisted snapshot when the source is unchanged — the
      // first-view fast path that avoids a full re-analysis after a restart.
      const counts = await source.summary(id);
      return c.json({ id, ...counts });
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }
  });

  // ── hotspots ──────────────────────────────────────────────────────────────

  app.get("/api/projects/:id/hotspots", async (c) => {
    const id = c.req.param("id");
    try {
      // Fingerprint-keyed disk cache (same rationale as vis-data below): a cold
      // just-restarted server answers from disk without re-analyzing the repo;
      // the metrics walk + node enumeration runs only on a miss.
      const hotspots = await source.cachedArtifact(id, "hotspots", async (ctx) => {
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

        return sorted.map((m) => {
          const node = nodeById.get(m.anchor);
          const relPath = node
            ? (() => {
                try {
                  return relative(
                    ctx.repoPath,
                    node.sourceRange.filePath,
                  ).replace(/\\/g, "/");
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
      });
      return c.json(hotspots);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }
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
    try {
      // Cached so a cold server lists domains from disk without re-analysing.
      const items = await source.cachedArtifact(id, "domains", async (ctx) =>
        (ctx.domains ?? []).map((d) => ({
          domain: d.domain,
          implementorCount: d.implementors.length,
          conforms: d.conforms,
          violationCount: d.violations.length,
        })),
      );
      return c.json(items);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }
  });

  // ── review ──────────────────────────────────────────────────────────────────

  /**
   * Deterministic structural review (rules × domain graph × AST graph + spec):
   * violations / hotspots / cycles / structural duplicates / domain coupling /
   * orphans / spec gaps, each with source file:line. No LLM.
   */
  app.get("/api/projects/:id/review", async (c) => {
    const id = c.req.param("id");
    const top = Number(c.req.query("topHotspots"));
    const max = Number(c.req.query("maxList"));
    const topHotspots = Number.isFinite(top) && top > 0 ? top : undefined;
    const maxList = Number.isFinite(max) && max > 0 ? max : undefined;
    // Each (topHotspots, maxList) variant gets its own cache key so a
    // parameterised request still answers from disk on a cold server; the
    // default (both unset) collapses to the bare "review" key. The params are
    // small bounded ints, so they go straight into the key (no hashing needed).
    const cacheName =
      topHotspots === undefined && maxList === undefined
        ? "review"
        : `review-t${topHotspots ?? "d"}-m${maxList ?? "d"}`;
    try {
      const report = await source.cachedArtifact(id, cacheName, (ctx) =>
        buildReview(ctx, { topHotspots, maxList }),
      );
      return c.json(report);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }
  });

  // ── vis-data ──────────────────────────────────────────────────────────────

  /**
   * Pre-built vis-network data (same structure as the static export).
   * The browser uses this directly to init vis.Network without server-side
   * HTML injection — same buildVisData() call, shared with export.ts.
   */
  app.get("/api/projects/:id/vis-data", async (c) => {
    const id = c.req.param("id");
    try {
      // Served from the fingerprint-keyed render cache when the source is
      // unchanged — a cold (just-restarted) server answers from disk without
      // re-analyzing the repo, which is what kept the graph view from toppling
      // the panel on large C++ projects. buildVisData runs only on a miss.
      const data = await source.cachedArtifact(id, "vis-data", (ctx) =>
        buildVisData(ctx),
      );
      return c.json(data);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }
  });
}
