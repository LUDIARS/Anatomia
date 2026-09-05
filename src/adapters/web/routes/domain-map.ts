/**
 * src/adapters/web/routes/domain-map.ts — `GET /api/domain-map/...` (design §12.3).
 *
 *   GET /api/domain-map/search?q=<指示文>&limit=N   ranked hits across every project
 *   GET /api/domain-map/:project                   one project's whole map
 *
 * These are GETs, not POSTs, because a map search has no side effects and costs
 * milliseconds: the Castra supply hook and the Cc delegation seed call it before
 * every coding prompt, and anything heavier than a cache lookup there would be
 * paid on every prompt. The bundle refreshes itself per project on source change
 * (map/bundle.ts), so the warm server never re-reads an unchanged repo.
 *
 * SRP: HTTP shaping. The index lives in src/map/.
 */

import type { Hono } from "hono";
import type { ProjectManager } from "../../../project/manager.js";
import { effectiveOntologyDir } from "../../../project/config-paths.js";
import {
  DEFAULT_SEARCH_LIMIT,
  loadDomainMapBundle,
  loadProjectDomainMap,
  searchDomainMap,
  type MapProjectSource,
} from "../../../map/index.js";

/** Upper bound on `limit`, so one request cannot ask for the whole index. */
const MAX_LIMIT = 50;
const MAX_QUERY_LENGTH = 4096;

/** Mount the domain-map routes. */
export function mountDomainMapRoutes(app: Hono, deps: { manager: ProjectManager | null }): void {
  app.get("/api/domain-map/search", async (c) => {
    const manager = deps.manager;
    if (!manager) return c.json({ error: "domain-map requires manager mode" }, 501);

    const query = (c.req.query("q") ?? "").trim();
    if (query === "") return c.json({ error: "q is required" }, 400);
    if (query.length > MAX_QUERY_LENGTH) return c.json({ error: "q is too long" }, 400);

    // Source keys refresh changed projects automatically. Deliberately do not
    // expose a force-refresh switch on this unauthenticated read route.
    const bundle = await loadDomainMapBundle(sourcesOf(manager));
    const hits = searchDomainMap(bundle.index, query, { limit: parseLimit(c.req.query("limit")) });
    return c.json({
      query,
      projects: bundle.index.projects,
      count: hits.length,
      hits: hits.map((hit) => ({
        project: hit.project,
        kind: hit.kind,
        name: hit.name,
        coreDomain: hit.coreDomain,
        programDomains: hit.programDomains,
        paths: hit.paths,
        spec: hit.spec,
        links: hit.links,
        score: hit.score,
      })),
      notes: bundle.notes,
    });
  });

  app.get("/api/domain-map/:project", async (c) => {
    const manager = deps.manager;
    if (!manager) return c.json({ error: "domain-map requires manager mode" }, 501);

    const requested = c.req.param("project");
    let id: string;
    try {
      id = manager.resolveId(requested);
    } catch {
      return c.json({ error: `no such project "${requested}"` }, 404);
    }
    const source = sourcesOf(manager).find((entry) => entry.id === id);
    if (!source) return c.json({ error: `no such project "${requested}"` }, 404);
    return c.json(await loadProjectDomainMap(source));
  });
}

function sourcesOf(manager: ProjectManager): MapProjectSource[] {
  return manager.list().map((project) => ({
    id: project.id,
    rootPath: project.rootPath,
    ontologyDir: effectiveOntologyDir(project),
    cacheDir: manager.cache.dirFor(project.id),
  }));
}

/** A missing / unparsable / out-of-range limit falls back to the default. */
function parseLimit(raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_SEARCH_LIMIT;
  return Math.min(value, MAX_LIMIT);
}
