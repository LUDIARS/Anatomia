/**
 * src/adapters/web/routes/domain-view.ts — Domain-view route.
 *
 * Route:
 *   GET /api/projects/:id/domain-view
 *     → { views, modulesByDomain, modularity, granularity, misfits, graphByDomain }
 *       - views: DomainView[] (domains/view.ts) — each domain + spec-derived JP
 *         description + implementor anchors (for focusing the graph);
 *       - modulesByDomain: domain → the 機能(module) it spans, each with cohesion
 *         (the right pane's scannable module list);
 *       - modularity/granularity/misfits: the module-aggregation evaluation;
 *       - graphByDomain: the precomputed per-domain feature-unit graph the panel
 *         renders (so it never downloads the full function graph to fold it).
 *
 * WHY a cached artifact: the payload is built from the analyzed context and was
 * previously recomputed on every open — which, on a cold (just-restarted) warm
 * server, forced a full re-analysis and made the panel hang for seconds. It is
 * now resolved through `cachedArtifact`, so after the first build it is served
 * straight from the fingerprint-keyed disk snapshot WITHOUT re-analysis.
 *
 * The per-domain unit graph needs vis-data nodes/edges (the resolved feature-unit
 * `group` per node), so this route builds vis-data and threads its nodes/edges
 * into the payload builder — keeping the domains layer free of an adapters dep.
 *
 * SRP: HTTP routing + 404 shaping. View assembly is in domains/view*.ts; module
 * evaluation in modules/.
 */

import type { Hono } from "hono";
import { buildDomainViewPayload } from "../../../domains/domain-view-payload.js";
import { buildVisData } from "../vis-data.js";
import { loadTaxonomyResolver } from "../../../domains/retune/load-taxonomy.js";
import type { WebContextSource } from "../context.js";

export function mountDomainViewRoute(app: Hono, source: WebContextSource): void {
  app.get("/api/projects/:id/domain-view", async (c) => {
    const id = c.req.param("id");
    try {
      const payload = await source.cachedArtifact(id, "domain-view", async (ctx) => {
        const moduleResolver = await loadTaxonomyResolver(ctx.repoPath);
        const vis = await buildVisData(ctx, undefined, { moduleResolver });
        return buildDomainViewPayload(ctx, undefined, vis.nodes, vis.edges);
      });
      return c.json(payload);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }
  });
}
