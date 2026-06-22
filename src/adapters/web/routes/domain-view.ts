/**
 * src/adapters/web/routes/domain-view.ts — Domain-view route.
 *
 * Route:
 *   GET /api/projects/:id/domain-view
 *     → { views, modulesByDomain, modularity, granularity, misfits }
 *       - views: DomainView[] (domains/view.ts) — each domain + spec-derived JP
 *         description + implementor anchors (for focusing the graph);
 *       - modulesByDomain: domain → the 機能(module) it spans, each with cohesion
 *         (the right pane's scannable module list);
 *       - modularity/granularity/misfits: the module-aggregation evaluation.
 *
 * WHY a cached artifact: the payload is built from the analyzed context and was
 * previously recomputed on every open — which, on a cold (just-restarted) warm
 * server, forced a full re-analysis and made the panel hang for seconds. It is
 * now resolved through `cachedArtifact`, so after the first build it is served
 * straight from the fingerprint-keyed disk snapshot WITHOUT re-analysis.
 *
 * SRP: HTTP routing + 404 shaping. View assembly is in domains/view*.ts; module
 * evaluation in modules/.
 */

import type { Hono } from "hono";
import { buildDomainView } from "../../../domains/view.js";
import { buildDomainModules } from "../../../domains/view-modules.js";
import { evaluateModulesFromGraph } from "../../../modules/evaluate.js";
import type { WebContextSource } from "../context.js";

export function mountDomainViewRoute(app: Hono, source: WebContextSource): void {
  app.get("/api/projects/:id/domain-view", async (c) => {
    const id = c.req.param("id");
    try {
      const payload = await source.cachedArtifact(id, "domain-view", async (ctx) => {
        // Spec links are file-anchored; domain implementors are function-anchored.
        // Pass the implementor→file map so file-anchored links reach their domain.
        const anchorToFile = new Map<string, string>();
        for (const fn of ctx.functions) {
          if (fn.id) anchorToFile.set(fn.id, fn.sourceRange.filePath);
        }
        const views = buildDomainView(
          ctx.domains ?? [],
          ctx.links ?? [],
          ctx.specClauses ?? [],
          anchorToFile,
        );
        const { evaluation } = await evaluateModulesFromGraph(ctx.graph, ctx.functions);
        const modulesByDomain = buildDomainModules(ctx.domains ?? [], evaluation);
        return {
          views,
          modulesByDomain,
          modularity: evaluation.modularity,
          granularity: evaluation.granularity,
          // Cap misfits surfaced to the panel (full set is large on real repos).
          misfits: evaluation.misfits.slice(0, 50),
        };
      });
      return c.json(payload);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }
  });
}
