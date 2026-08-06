/** Screen detection plus explicit canonical scene sync/read routes. */

import type { Hono } from "hono";
import { detectScreens } from "../../../screens/index.js";
import { deriveScenes } from "../../../scenes/derive.js";
import { loadScenes, mergeSceneModel } from "../../../scenes/store.js";
import type { ProjectManager } from "../../../project/manager.js";
import { KnowledgeApplicationService, knowledgePortFromManager } from "../../../knowledge/application/index.js";
import type { SceneInspection } from "../../../knowledge/scene/index.js";
import type { WebContextSource } from "../context.js";
import { sceneKnowledgePage } from "../scene-knowledge-page.js";

function compatibility(inspection: SceneInspection) {
  const scenes = inspection.scenes.filter((scene) => !scene.tombstone).map((scene) => ({
    id: scene.id, label: scene.annotation?.label ?? scene.label, domains: scene.activeDomainIds,
  }));
  return {
    derived: { version: 1, scenes: inspection.scenes, summary: {
      total: inspection.scenes.length,
      withEntries: inspection.scenes.filter((scene) => scene.entryCodeSymbolIds.length > 0).length,
      transitions: inspection.scenes.reduce((total, scene) => total + scene.transitionSceneIds.length, 0),
      domainsCovered: new Set(inspection.scenes.flatMap((scene) => scene.activeDomainIds)).size,
    } },
    manual: [],
    merged: scenes,
  };
}

function service(manager: ProjectManager, id: string) {
  return new KnowledgeApplicationService(knowledgePortFromManager(manager, id));
}

export function mountScreenRoutes(app: Hono, source: WebContextSource, manager: ProjectManager | null): void {
  app.get("/scene-knowledge/:id", (c) => c.html(sceneKnowledgePage(c.req.param("id"))));
  app.get("/api/projects/:id/screens", async (c) => {
    const id = c.req.param("id");
    try { return c.json(await detectScreens(await source.resolve(id))); }
    catch { return c.json({ error: `no such project "${id}"` }, 404); }
  });

  app.get("/api/projects/:id/scenes", async (c) => {
    const id = c.req.param("id");
    const listed = source.projects().find((candidate) => candidate.id === id);
    if (!listed) return c.json({ error: `no such project "${id}"` }, 404);
    if (!manager) {
      const context = await source.resolve(id);
      const derived = await deriveScenes(context, await detectScreens(context));
      const manual = await loadScenes(listed.rootPath, listed.name);
      return c.json({ derived, manual, merged: mergeSceneModel(manual, derived.scenes).scenes() });
    }
    try {
      const inspection = await service(manager, id).scenes.query();
      return c.json({ ...inspection, ...compatibility(inspection) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const status = await service(manager, id).status();
        return c.json({ manifest: null, knowledgeHead: status.knowledgeHead, scenes: [], observations: [], stale: true,
          staleReasons: status.staleReasons, derived: null, manual: [], merged: [] });
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  app.post("/api/projects/:id/scenes/sync", async (c) => {
    if (!manager) return c.json({ error: "project management requires manager mode" }, 501);
    try {
      const body = await c.req.json() as { confirmSync?: boolean; expectedHead?: string | null };
      if (!("expectedHead" in body)) throw new Error("scene sync requires expectedHead");
      return c.json(await service(manager, c.req.param("id")).scenes.sync({
        confirmSync: body.confirmSync === true,
        expectedHead: body.expectedHead ?? null,
      }));
    } catch (error) {
      const status = /unknown project|no such project/i.test(String(error)) ? 404
        : /conflict|changed|expectedHead/i.test(String(error)) ? 409 : 400;
      return c.json({ error: error instanceof Error ? error.message : String(error) }, status);
    }
  });
}
