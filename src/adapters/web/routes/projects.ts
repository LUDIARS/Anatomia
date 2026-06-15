/**
 * src/adapters/web/routes/projects.ts — Project management API routes.
 *
 * Mounted at /api/projects. Mutation routes (POST, DELETE) require a
 * ProjectManager; read-only listing works through any WebContextSource.
 *
 * Routes:
 *   GET    /api/projects           list registered projects + selected id
 *   POST   /api/projects           register + analyze a new project
 *   DELETE /api/projects/:id       remove a project
 *   POST   /api/projects/:id/analyze   (re)analyze an existing project
 *
 * SRP: HTTP routing for project lifecycle. No analysis logic here.
 */

import type { Hono } from "hono";
import { ProjectManager } from "../../../project/manager.js";
import type { WebContextSource } from "../context.js";

/**
 * Mount all project management routes on `app`.
 *
 * @param app     Hono application to attach routes to.
 * @param source  Context source (read-only list + resolve).
 * @param manager ProjectManager for mutations (null in single-context mode → 501).
 */
export function mountProjectRoutes(
  app: Hono,
  source: WebContextSource,
  manager: ProjectManager | null,
): void {
  // GET /api/projects — list + selected
  app.get("/api/projects", (c) => {
    return c.json({ projects: source.projects(), selected: source.selected() });
  });

  // POST /api/projects — register + analyze { name, rootPath }
  app.post("/api/projects", async (c) => {
    if (!manager) {
      return c.json({ error: "project management requires manager mode" }, 501);
    }
    let body: { name?: string; rootPath?: string };
    try {
      body = (await c.req.json()) as { name?: string; rootPath?: string };
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const { name, rootPath } = body;
    if (!name || !rootPath) {
      return c.json({ error: "name and rootPath are required" }, 400);
    }
    const project = await manager.addProject({ name, rootPath });
    const ctx = await manager.analyzeProject(project.id);
    return c.json(
      {
        project,
        analyzed: { files: ctx.files.length, functions: ctx.functions.length },
      },
      201,
    );
  });

  // DELETE /api/projects/:id — remove project + its cache
  app.delete("/api/projects/:id", async (c) => {
    if (!manager) {
      return c.json({ error: "project management requires manager mode" }, 501);
    }
    const id = c.req.param("id");
    const ok = await manager.removeProject(id);
    if (!ok) return c.json({ error: `no such project "${id}"` }, 404);
    return c.json({ removed: true, id });
  });

  // POST /api/projects/:id/analyze — force (re)analyze (invalidates cache first)
  app.post("/api/projects/:id/analyze", async (c) => {
    if (!manager) {
      return c.json({ error: "project management requires manager mode" }, 501);
    }
    const id = c.req.param("id");
    try {
      manager.cache.invalidate(id);
      const ctx = await manager.analyzeProject(id);
      return c.json({
        project: id,
        files: ctx.files.length,
        functions: ctx.functions.length,
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        404,
      );
    }
  });
}
