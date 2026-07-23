/**
 * src/adapters/web/routes/screens.ts — Screen-composition + derived-scene routes.
 *
 * Routes:
 *   GET /api/projects/:id/screens
 *     → ScreenGraph (screens/detect.ts): heuristically-detected UI screens with
 *       their composition (contains) + navigation (navigatesTo) + owning domains.
 *   GET /api/projects/:id/scenes
 *     → { derived, manual, merged }: the call-graph-derived scene layer
 *       (scenes/derive.ts) served from the fingerprint-keyed artifact cache
 *       (the scene cache), plus manual scenes merged at read time. This is the
 *       endpoint downstream analyses (Omnipotens 等) read for scene data
 *       without re-analyzing.
 *
 * SRP: HTTP routing + 404 shaping. Detection lives in screens/detect.ts,
 * derivation in scenes/derive.ts, persistence in project/cache.ts artifacts.
 */

import type { Hono } from "hono";
import { detectScreens } from "../../../screens/index.js";
import { deriveScenes } from "../../../scenes/derive.js";
import { loadScenes, mergeSceneModel } from "../../../scenes/store.js";
import type { WebContextSource } from "../context.js";

export function mountScreenRoutes(app: Hono, source: WebContextSource): void {
  app.get("/api/projects/:id/screens", async (c) => {
    const id = c.req.param("id");
    let ctx;
    try {
      ctx = await source.resolve(id);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }
    const graph = await detectScreens(ctx);
    return c.json(graph);
  });

  app.get("/api/projects/:id/scenes", async (c) => {
    const id = c.req.param("id");
    const project = source.projects().find((p) => p.id === id);
    if (!project) return c.json({ error: `no such project "${id}"` }, 404);
    // Derived part: pure function of the analyzed source → artifact-cacheable.
    // Manual part: spec/data/<name>.scenes.json is NOT in the fingerprint, so
    // it is merged per-request — an edit shows up without a re-analysis.
    const derived = await source.cachedArtifact(id, "scenes-derived", async (ctx) =>
      deriveScenes(ctx, await detectScreens(ctx)),
    );
    const manual = await loadScenes(project.rootPath, project.name);
    const merged = mergeSceneModel(manual, derived.scenes).scenes();
    return c.json({ derived, manual, merged });
  });
}
