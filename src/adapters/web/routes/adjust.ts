/** Read-only legacy Adjust compatibility; all authoritative writes use knowledge Gate commands. */
// @implements SPEC-knowledge-adapter-migration

import type { Context, Hono } from "hono";
import type { ProjectManager } from "../../../project/manager.js";
import { emptyTaxonomy } from "../../../domains/retune/taxonomy-ops.js";
import { loadTaxonomy } from "../../../domains/retune/taxonomy-store.js";
import { KnowledgeApplicationService, knowledgePortFromManager } from "../../../knowledge/application/index.js";

export interface AdjustRouteDeps { manager: ProjectManager | null }

function removed(c: Context) {
  return c.json({
    error: "legacy direct write was removed; use /domain-organization Gate A/B/C or /scenes/sync",
  }, 410);
}

/** The old panel may still read this model while T68 source artifacts are retained. */
export function mountAdjustRoutes(app: Hono, deps: AdjustRouteDeps): void {
  app.get("/api/projects/:id/adjust/model", async (c) => {
    if (!deps.manager) return c.json({ error: "adjustment requires manager mode" }, 501);
    let port: ReturnType<typeof knowledgePortFromManager>;
    try {
      port = knowledgePortFromManager(deps.manager, c.req.param("id"));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
    const taxonomy = await loadTaxonomy(port.project.rootPath, port.project.name);
    const application = new KnowledgeApplicationService(port);
    try {
      const inspection = await application.scenes.query();
      return c.json({ taxonomy: taxonomy ?? emptyTaxonomy(port.project.name), scenes: inspection.scenes, sceneStatus: {
        knowledgeHead: inspection.manifest.knowledgeHead, sourceRevision: inspection.manifest.sourceRevision,
        stale: inspection.stale, staleReasons: inspection.staleReasons,
      }, authoritativeWrites: "knowledge-gates" });
    } catch (error) {
      return c.json({ taxonomy: taxonomy ?? emptyTaxonomy(port.project.name), scenes: [],
        sceneStatus: { stale: true, staleReasons: [error instanceof Error ? error.message : String(error)] },
        authoritativeWrites: "knowledge-gates" });
    }
  });

  app.post("/api/projects/:id/adjust/domain", removed);
  app.post("/api/projects/:id/adjust/module", removed);
  app.post("/api/projects/:id/adjust/scene", removed);
  app.post("/api/projects/:id/adjust/domain-organization", removed);
  app.post("/api/projects/:id/adjust/retune", removed);
}
