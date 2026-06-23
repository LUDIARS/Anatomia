/**
 * src/adapters/web/routes/adjust.ts — Domain / module / scene adjustment routes.
 *
 * The adjustment view edits the curated model:
 *   GET  /api/projects/:id/adjust/model    current { taxonomy, scenes }
 *   POST /api/projects/:id/adjust/domain   add | delete | rename a domain
 *   POST /api/projects/:id/adjust/module   add | delete | rename | move | addPath
 *   POST /api/projects/:id/adjust/scene    add | delete a scene (局面)
 *   POST /api/projects/:id/adjust/retune   run the granularity auto-flow (retune)
 *
 * Domain/module edits mutate the taxonomy and SAVE through taxonomy-store, which
 * re-registers the ontology DomainDefs + the taxonomy spec doc — so spec is
 * adjusted automatically (「仕様の調整も自動で行う」). Retune is the same
 * auto-search flow (`npm run retune`) the user referenced for granularity. Both
 * invalidate the analysis cache so the next prepare re-analyzes.
 *
 * Retune fails FAST on the stub LLM (no silent no-op) — feedback_no_silent_fallback.
 *
 * SRP: HTTP shaping + persistence wiring. Mutations use taxonomy-ops; the run
 * lives in domains/retune.
 */

import type { Context, Hono } from "hono";
import type { ProjectManager } from "../../../project/manager.js";
import type { LLMClient } from "../../../domains/card.js";
import type { Taxonomy } from "../../../domains/retune/types.js";
import {
  kebab,
  emptyTaxonomy,
  findOrCreateDomain,
  findOrCreateModule,
  addDir,
} from "../../../domains/retune/taxonomy-ops.js";
import { loadTaxonomy, saveTaxonomy } from "../../../domains/retune/taxonomy-store.js";
import { runRetuneOnContext } from "../../../domains/retune/index.js";
import { loadScenes, saveScenes } from "../../../scenes/store.js";
import type { SceneRef } from "../../../integral/scene.js";

export interface AdjustRouteDeps {
  manager: ProjectManager | null;
  /** LLM for retune. Absent / stub → retune fails fast. */
  retuneLlm?: LLMClient;
  retuneModelId?: string;
}

/** Resolve a project + its repo path, or null. */
function resolveProject(manager: ProjectManager, id: string) {
  const projectId = manager.resolveId(id);
  const project = manager.get(projectId);
  return project ?? null;
}

export function mountAdjustRoutes(app: Hono, deps: AdjustRouteDeps): void {
  const { manager } = deps;

  // GET adjust/model — current editable model.
  app.get("/api/projects/:id/adjust/model", async (c) => {
    if (!manager) return c.json({ error: "adjustment requires manager mode" }, 501);
    const id = c.req.param("id");
    let project;
    try {
      project = resolveProject(manager, id);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }
    if (!project) return c.json({ error: `no such project "${id}"` }, 404);
    const [taxonomy, scenes] = await Promise.all([
      loadTaxonomy(project.rootPath, project.name),
      loadScenes(project.rootPath, project.name),
    ]);
    return c.json({ taxonomy: taxonomy ?? emptyTaxonomy(project.name), scenes });
  });

  // POST adjust/domain — add | delete | rename.
  app.post("/api/projects/:id/adjust/domain", async (c) => {
    return mutateTaxonomy(c, deps, async (t, body) => {
      const action = String(body.action ?? "");
      const name = String(body.name ?? "");
      if (!name) throw new Error("name is required");
      if (action === "add") {
        findOrCreateDomain(t, name, String(body.description ?? ""));
      } else if (action === "delete") {
        const id = kebab(name);
        t.domains = t.domains.filter((d) => d.name !== id);
      } else if (action === "rename") {
        const newName = kebab(String(body.newName ?? ""));
        if (!newName) throw new Error("newName is required for rename");
        const d = t.domains.find((x) => x.name === kebab(name));
        if (!d) throw new Error(`no such domain "${name}"`);
        d.name = newName;
        if (body.description !== undefined) d.description = String(body.description);
      } else {
        throw new Error(`unknown domain action "${action}"`);
      }
    });
  });

  // POST adjust/module — add | delete | rename | move | addPath.
  app.post("/api/projects/:id/adjust/module", async (c) => {
    return mutateTaxonomy(c, deps, async (t, body) => {
      const action = String(body.action ?? "");
      const domainName = kebab(String(body.domain ?? ""));
      const name = String(body.name ?? "");
      const domain = t.domains.find((x) => x.name === domainName);
      if (!domain) throw new Error(`no such domain "${body.domain}"`);
      if (!name) throw new Error("name is required");
      if (action === "add") {
        const m = findOrCreateModule(domain, name, String(body.description ?? ""));
        if (typeof body.path === "string" && body.path) addDir(m, body.path);
      } else if (action === "delete") {
        const id = kebab(name);
        domain.modules = domain.modules.filter((m) => m.name !== id);
      } else if (action === "rename") {
        const newName = kebab(String(body.newName ?? ""));
        if (!newName) throw new Error("newName is required for rename");
        const m = domain.modules.find((x) => x.name === kebab(name));
        if (!m) throw new Error(`no such module "${name}"`);
        m.name = newName;
        if (body.description !== undefined) m.description = String(body.description);
      } else if (action === "addPath") {
        const m = domain.modules.find((x) => x.name === kebab(name));
        if (!m) throw new Error(`no such module "${name}"`);
        if (typeof body.path !== "string" || !body.path) throw new Error("path is required");
        addDir(m, body.path);
      } else if (action === "move") {
        const target = t.domains.find((x) => x.name === kebab(String(body.newDomain ?? "")));
        if (!target) throw new Error(`no such target domain "${body.newDomain}"`);
        const id = kebab(name);
        const idx = domain.modules.findIndex((m) => m.name === id);
        if (idx < 0) throw new Error(`no such module "${name}"`);
        const [m] = domain.modules.splice(idx, 1);
        target.modules.push(m!);
      } else {
        throw new Error(`unknown module action "${action}"`);
      }
    });
  });

  // POST adjust/scene — add | delete a manual scene.
  app.post("/api/projects/:id/adjust/scene", async (c) => {
    if (!manager) return c.json({ error: "adjustment requires manager mode" }, 501);
    const id = c.req.param("id");
    let project;
    try {
      project = resolveProject(manager, id);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }
    if (!project) return c.json({ error: `no such project "${id}"` }, 404);
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const action = String(body["action"] ?? "");
    const sceneId = String(body["id"] ?? "").trim();
    if (!sceneId) return c.json({ error: "id is required" }, 400);
    const scenes = await loadScenes(project.rootPath, project.name);
    if (action === "add") {
      const domains = Array.isArray(body["domains"])
        ? (body["domains"] as unknown[]).map(String)
        : [];
      const label = typeof body["label"] === "string" ? (body["label"] as string) : undefined;
      const next: SceneRef = { id: sceneId, label, domains: [...new Set(domains)].sort() };
      const existing = scenes.findIndex((s) => s.id === sceneId);
      if (existing >= 0) scenes[existing] = next;
      else scenes.push(next);
    } else if (action === "delete") {
      const idx = scenes.findIndex((s) => s.id === sceneId);
      if (idx < 0) return c.json({ error: `no such scene "${sceneId}"` }, 404);
      scenes.splice(idx, 1);
    } else {
      return c.json({ error: `unknown scene action "${action}"` }, 400);
    }
    await saveScenes(project.rootPath, project.name, scenes);
    return c.json({ ok: true, scenes });
  });

  // POST adjust/retune — granularity auto-flow (the retune pipeline).
  app.post("/api/projects/:id/adjust/retune", async (c) => {
    if (!manager) return c.json({ error: "adjustment requires manager mode" }, 501);
    if (!deps.retuneLlm || deps.retuneModelId === "stub-llm") {
      return c.json(
        {
          error:
            "retune requires a real LLM — set an Anthropic API key (ANTHROPIC_API_KEY). No silent no-op.",
        },
        501,
      );
    }
    const id = c.req.param("id");
    let project;
    try {
      project = resolveProject(manager, id);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }
    if (!project) return c.json({ error: `no such project "${id}"` }, 404);
    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      /* options are optional */
    }
    const options = {
      largePercentile: numOpt(body["largePercentile"]),
      maxModulesPerDomain: numOpt(body["maxModulesPerDomain"]),
      minNodesPerModule: numOpt(body["minNodesPerModule"]),
      now: new Date().toISOString(),
    };
    try {
      const ctx = await manager.getContext(id);
      const report = await runRetuneOnContext(ctx, {
        project: project.name,
        llm: deps.retuneLlm,
        options,
      });
      // Point the project at the regenerated ontology + drop the stale analysis.
      project.ontologyDir = report.ontologyDir;
      await manager.save();
      manager.cache.invalidate(project.id);
      return c.json({
        project: project.id,
        iteration: report.iteration,
        domains: report.taxonomy.domains.length,
        modules: report.taxonomy.domains.reduce((n, d) => n + d.modules.length, 0),
        written: report.written,
        haltForHuman: report.haltForHuman,
        humanReviewNotes: report.humanReviewNotes,
        steps: report.steps,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  /**
   * Shared taxonomy-mutation handler: load (or seed) the taxonomy, apply `mutate`,
   * save (re-registers ontology + spec), and invalidate the analysis cache.
   */
  async function mutateTaxonomy(
    c: Context,
    d: AdjustRouteDeps,
    mutate: (t: Taxonomy, body: Record<string, unknown>) => Promise<void>,
  ) {
    if (!d.manager) return c.json({ error: "adjustment requires manager mode" }, 501);
    const id = c.req.param("id") ?? "";
    let project;
    try {
      project = resolveProject(d.manager, id);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }
    if (!project) return c.json({ error: `no such project "${id}"` }, 404);
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const taxonomy = (await loadTaxonomy(project.rootPath, project.name)) ?? emptyTaxonomy(project.name);
    try {
      await mutate(taxonomy, body);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    const result = await saveTaxonomy(project.rootPath, taxonomy);
    project.ontologyDir = result.ontologyDir;
    await d.manager.save();
    d.manager.cache.invalidate(project.id);
    return c.json({ ok: true, taxonomy, written: result.written });
  }
}

function numOpt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
