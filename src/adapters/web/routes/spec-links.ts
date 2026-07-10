/**
 * src/adapters/web/routes/spec-links.ts — spec-link mutation routes.
 *
 * Routes:
 *   POST /api/projects/:id/spec-links/ratify — ratify a (from, to) link and
 *        persist it to the project's committed spec/data/spec-links.json.
 *
 * Kept out of analysis.ts on purpose: that module is the read-only analysis
 * data surface; this one MUTATES a committed artifact and invalidates the
 * project's analysis cache. Requires manager mode (a registered rootPath to
 * write into) — legacy single-context mode returns 501 like the other
 * mutation routes.
 *
 * SRP: HTTP shaping only. Ratification semantics live in spec/ratify.ts.
 */

import type { Hono } from "hono";
import type { ProjectManager } from "../../../project/manager.js";
import { ratifyLink, SpecLinkRatifyError } from "../../../spec/ratify.js";

export interface SpecLinkRouteDeps {
  manager: ProjectManager | null;
}

export function mountSpecLinkRoutes(app: Hono, deps: SpecLinkRouteDeps): void {
  const { manager } = deps;

  app.post("/api/projects/:id/spec-links/ratify", async (c) => {
    if (!manager) return c.json({ error: "spec-link ratify requires manager mode" }, 501);
    const id = c.req.param("id");
    let project;
    try {
      project = manager.get(manager.resolveId(id)) ?? null;
    } catch {
      project = null;
    }
    if (!project) return c.json({ error: `no such project "${id}"` }, 404);

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const from = typeof body["from"] === "string" ? body["from"] : "";
    const to = typeof body["to"] === "string" ? body["to"] : "";
    if (!from || !to) {
      return c.json({ error: "from (anchor) and to (clause id) are required" }, 400);
    }

    try {
      const ctx = await manager.getContext(project.id);
      const result = await ratifyLink({
        repoRoot: project.rootPath,
        from,
        to,
        links: ctx.links ?? [],
        specClauses: ctx.specClauses ?? [],
      });
      // The artifact changed under rootPath; drop the cached context so the
      // next analysis re-merges the ratified set.
      manager.cache.invalidate(project.id);
      return c.json({
        project: project.id,
        link: result.link,
        path: result.path,
        wasProposed: result.wasProposed,
      });
    } catch (err) {
      if (err instanceof SpecLinkRatifyError) {
        return c.json({ error: err.message }, 400);
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
}
