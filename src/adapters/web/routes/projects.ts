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
 *   GET    /api/projects/:id/spec-config  where spec clauses come from
 *                                  (configured / auto / root / missing)
 *   PUT    /api/projects/:id/spec-config  set { specDirs: string[] } or
 *                                  clear with { specDirs: null } (→ auto-detect)
 *
 * SRP: HTTP routing for project lifecycle. No analysis logic here.
 */

import type { Hono } from "hono";
import { ProjectManager } from "../../../project/manager.js";
import { AnalysisQueue } from "../../../project/analysis-queue.js";
import type { WebContextSource } from "../context.js";
import type { AnalysisContext } from "../../../core.js";

/**
 * Mount all project management routes on `app`.
 *
 * @param app             Hono application to attach routes to.
 * @param source          Context source (read-only list + resolve).
 * @param manager         ProjectManager for mutations (null in single-context mode → 501).
 * @param onAfterAnalyze  Optional fire-and-forget callback called after a (re)analyze
 *                        succeeds. Used to pre-warm LLM caches (domain cards) so
 *                        subsequent verify/context calls get cache hits instead of
 *                        cold LLM distillation. Failures are silently ignored.
 */
export function mountProjectRoutes(
  app: Hono,
  source: WebContextSource,
  manager: ProjectManager | null,
  onAfterAnalyze?: (ctx: AnalysisContext) => void,
): void {
  const analyzeQueue = manager
    ? new AnalysisQueue(async (projectId, setPhase) => {
        setPhase("invalidating cache");
        manager.cache.invalidate(projectId);
        setPhase("analyzing");
        const ctx = await manager.analyzeProject(projectId);
        setPhase("prewarming");
        if (onAfterAnalyze) try { onAfterAnalyze(ctx); } catch { /* pre-warm is optional */ }
        return { files: ctx.files.length, functions: ctx.functions.length };
      })
    : null;

  // GET /api/projects — list + selected
  app.get("/api/projects", (c) => {
    return c.json({ projects: source.projects(), selected: source.selected() });
  });

  app.get("/api/analyze-jobs", (c) => {
    if (!analyzeQueue) {
      return c.json({ error: "project management requires manager mode" }, 501);
    }
    return c.json({ jobs: analyzeQueue.jobs(), active: analyzeQueue.active });
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
    if (onAfterAnalyze) try { onAfterAnalyze(ctx); } catch { /* pre-warm is optional */ }
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

  // GET /api/projects/:id/spec-config — spec-source resolution for the dashboard.
  // Runs the same ensure step analyze uses, so an unset project may auto-detect
  // (and persist) here; "missing" is the report the user asked to see.
  app.get("/api/projects/:id/spec-config", async (c) => {
    if (!manager) {
      return c.json({ error: "project management requires manager mode" }, 501);
    }
    const id = c.req.param("id");
    try {
      const projectId = manager.resolveId(id);
      const status = await manager.ensureSpecConfig(projectId);
      return c.json({ projectId, ...status });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  // PUT /api/projects/:id/spec-config — set/clear the spec dirs from the dashboard
  app.put("/api/projects/:id/spec-config", async (c) => {
    if (!manager) {
      return c.json({ error: "project management requires manager mode" }, 501);
    }
    const id = c.req.param("id");
    let body: { specDirs?: string[] | null };
    try {
      body = (await c.req.json()) as { specDirs?: string[] | null };
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (body.specDirs !== null && !Array.isArray(body.specDirs)) {
      return c.json({ error: "specDirs must be an array of dirs, or null to clear" }, 400);
    }
    if (Array.isArray(body.specDirs) && body.specDirs.some((d) => typeof d !== "string" || !d.trim())) {
      return c.json({ error: "specDirs entries must be non-empty strings" }, 400);
    }
    try {
      const projectId = manager.resolveId(id);
      await manager.updateSpecDirs(projectId, body.specDirs === null ? null : body.specDirs!);
      const status = await manager.ensureSpecConfig(projectId);
      return c.json({ projectId, ...status });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = /no such project|unknown project/i.test(message) ? 404 : 400;
      return c.json({ error: message }, code);
    }
  });

  // POST /api/projects/:id/analyze — force (re)analyze (invalidates cache first)
  app.post("/api/projects/:id/analyze", async (c) => {
    if (!manager || !analyzeQueue) {
      return c.json({ error: "project management requires manager mode" }, 501);
    }
    const id = c.req.param("id");
    try {
      const projectId = manager.resolveId(id);
      if (!manager.get(projectId)) return c.json({ error: `no such project "${id}"` }, 404);
      const job = analyzeQueue.enqueue(projectId);
      return c.json({ jobId: job.id, projectId: job.projectId, state: job.state }, 202);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        404,
      );
    }
  });
}
