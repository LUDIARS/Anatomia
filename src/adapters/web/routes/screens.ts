/** Screen detection plus explicit canonical scene sync/read routes. */

import { readFile } from "node:fs/promises";
import type { Hono } from "hono";
import { detectScreens } from "../../../screens/index.js";
import { deriveScenes } from "../../../scenes/derive.js";
import { loadScenes, mergeSceneModel } from "../../../scenes/store.js";
import { replayKnowledgeLog } from "../../../knowledge/log.js";
import {
  deriveCanonicalSceneGraph,
  inventoryFromManifest,
  inventoryScreenScenes,
  computeSceneSourceRevision,
  readProjectSceneInspection,
  readSceneManifest,
  reconcileSceneInventory,
  sceneKnowledgePaths,
  syncCanonicalScenes,
  type SceneInspection,
} from "../../../knowledge/scene/index.js";
import type { KnowledgeGraph } from "../../../knowledge/types.js";
import type { WebContextSource } from "../context.js";
import { sceneKnowledgePage } from "../scene-knowledge-page.js";

async function readKnowledge(path: string): Promise<KnowledgeGraph> {
  try { return replayKnowledgeLog(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return replayKnowledgeLog("");
    throw error;
  }
}

function compatibility(inspection: SceneInspection) {
  const scenes = inspection.scenes.filter((scene) => !scene.tombstone).map((scene) => ({
    id: scene.id,
    label: scene.annotation?.label ?? scene.label,
    domains: scene.activeDomainIds,
  }));
  return {
    derived: {
      version: 1,
      scenes: inspection.scenes,
      summary: {
        total: inspection.scenes.length,
        withEntries: inspection.scenes.filter((scene) => scene.entryCodeSymbolIds.length > 0).length,
        transitions: inspection.scenes.reduce((total, scene) => total + scene.transitionSceneIds.length, 0),
        domainsCovered: new Set(inspection.scenes.flatMap((scene) => scene.activeDomainIds)).size,
      },
    },
    manual: [],
    merged: scenes,
  };
}

export function mountScreenRoutes(app: Hono, source: WebContextSource): void {
  app.get("/scene-knowledge/:id", (c) => c.html(sceneKnowledgePage(c.req.param("id"))));
  app.get("/api/projects/:id/screens", async (c) => {
    const id = c.req.param("id");
    let context;
    try {
      context = await source.resolve(id);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }
    return c.json(await detectScreens(context));
  });

  app.get("/api/projects/:id/scenes", async (c) => {
    const id = c.req.param("id");
    const listed = source.projects().find((candidate) => candidate.id === id);
    if (!listed) return c.json({ error: `no such project "${id}"` }, 404);
    const project = source.registeredProject(id);
    if (!project) {
      const context = await source.resolve(id);
      const derived = await deriveScenes(context, await detectScreens(context));
      const manual = await loadScenes(listed.rootPath, listed.name);
      return c.json({ derived, manual, merged: mergeSceneModel(manual, derived.scenes).scenes() });
    }
    try {
      const inspection = await readProjectSceneInspection(project);
      return c.json({ ...inspection, ...compatibility(inspection) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const paths = sceneKnowledgePaths(project);
        const state = await readKnowledge(paths.knowledgeLogPath);
        return c.json({
          manifest: null,
          knowledgeHead: state.head,
          scenes: [],
          observations: [],
          stale: true,
          staleReasons: ["manifest-missing"],
          derived: null,
          manual: [],
          merged: [],
        });
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  app.post("/api/projects/:id/scenes/sync", async (c) => {
    const id = c.req.param("id");
    if (!source.projects().some((candidate) => candidate.id === id)) {
      return c.json({ error: `no such project "${id}"` }, 404);
    }
    const project = source.registeredProject(id);
    if (!project) return c.json({ error: "canonical scene sync requires a registered project" }, 501);
    try {
      const body = await c.req.json() as { confirmSync?: boolean; expectedHead?: string | null };
      if (body.confirmSync !== true) throw new Error("scene sync requires confirmSync=true");
      if (!("expectedHead" in body)) throw new Error("scene sync requires expectedHead");
      const paths = sceneKnowledgePaths(project);
      const state = await readKnowledge(paths.knowledgeLogPath);
      if (body.expectedHead !== state.head) {
        return c.json({ error: `scene sync head conflict: expected ${body.expectedHead}, got ${state.head}` }, 409);
      }
      const context = await source.resolve(id);
      const sourceRevision = await computeSceneSourceRevision(project);
      const current = await inventoryScreenScenes(id, context, await detectScreens(context), sourceRevision);
      let definitions = current;
      try {
        const previous = await readSceneManifest(paths.manifestPath);
        definitions = reconcileSceneInventory(inventoryFromManifest(previous.manifest), current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const graph = await deriveCanonicalSceneGraph({
        projectId: id,
        sourceRevision,
        context,
        definitions,
        knowledgeState: state,
      });
      const result = await syncCanonicalScenes({
        graph,
        knowledgeLogPath: paths.knowledgeLogPath,
        generatedRoot: paths.generatedRoot,
        expectedHead: state.head,
        readCurrentSourceRevision: () => computeSceneSourceRevision(project),
      });
      return c.json(result);
    } catch (error) {
      const status = /conflict|changed|expectedHead/i.test(String(error)) ? 409 : 400;
      return c.json({ error: error instanceof Error ? error.message : String(error) }, status);
    }
  });
}
