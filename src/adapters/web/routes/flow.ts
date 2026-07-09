/**
 * src/adapters/web/routes/flow.ts — 学習フロー routes (domain draft authoring via HTTP).
 *
 * Routes:
 *   POST /api/projects/:id/flow/draft  — run domains draft on a registered project
 *   GET  /api/projects/:id/flow/drafts — list current editable domains for a project
 *   POST /api/flow/draft               — repo-path-based or spec-file-based draft
 *   GET  /api/flow/drafts              — list drafts from an explicit dir (?dir=)
 *
 * The "学習フロー" feeds source material into synthesizeDomainDrafts (LLM) or
 * seedDraftsFromStructure (deterministic), reconciles with existing editable defs,
 * and saves to the domains dir — mirroring `anatomia domains draft` over HTTP so
 * the management panel SPA can trigger it from the browser.
 *
 * Input modes (priority order for /api/flow/draft):
 *   repoPath  — full repo analysis; specClauses + filePaths from analyze()
 *   specPath  — parse a single spec file; specClauses only, filePaths=[]
 *
 * SRP: HTTP shaping + LLM/cache wiring. Synthesis stays in domains/authoring/.
 */

import type { Hono } from "hono";
import type { ProjectManager } from "../../../project/manager.js";
import type { LLMClient } from "../../../domains/card.js";
import type { SpecClause } from "../../../types.js";
import {
  domainsDir,
  loadEditableDomains,
  saveEditableDomains,
  synthesizeDomainDrafts,
  seedDraftsFromStructure,
  reconcileDrafts,
  type DraftCache,
  type DomainDraft,
} from "../../../domains/authoring/index.js";
import { parseMdFile } from "../../../spec/parse.js";
import { analyze } from "../../../core.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FlowRouteDeps {
  manager: ProjectManager | null;
  /** Real LLM client for draft synthesis. Absent / stub → draft fails fast. */
  draftLlm?: LLMClient;
  draftModelId?: string;
  draftCache?: DraftCache;
}

interface DraftInputs {
  specClauses: SpecClause[];
  filePaths: string[];
}

interface DraftOpts {
  noLlm: boolean;
  only: string[];
  force: boolean;
}

interface DraftSummary {
  drafted: number;
  added: string[];
  updated: string[];
  preserved: string[];
  total: number;
}

// ---------------------------------------------------------------------------
// Route mounting
// ---------------------------------------------------------------------------

export function mountFlowRoutes(app: Hono, deps: FlowRouteDeps): void {
  const { manager } = deps;

  // GET /api/projects/:id/flow/drafts — list current editable domains.
  app.get("/api/projects/:id/flow/drafts", async (c) => {
    if (!manager) return c.json({ error: "flow requires manager mode" }, 501);
    const id = c.req.param("id");
    const project = resolveProject(manager, id);
    if (!project) return c.json({ error: `no such project "${id}"` }, 404);
    const dir = project.ontologyDir ?? domainsDir(project.rootPath);
    const defs = await loadEditableDomains(dir);
    return c.json({ dir, domains: defs });
  });

  // POST /api/projects/:id/flow/draft — run domains draft on a registered project.
  app.post("/api/projects/:id/flow/draft", async (c) => {
    if (!manager) return c.json({ error: "flow requires manager mode" }, 501);
    const id = c.req.param("id");
    const project = resolveProject(manager, id);
    if (!project) return c.json({ error: `no such project "${id}"` }, 404);

    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      /* options body is optional */
    }

    const opts = parseDraftOpts(body);
    const dir =
      (typeof body["dir"] === "string" ? body["dir"] : undefined) ??
      project.ontologyDir ??
      domainsDir(project.rootPath);

    try {
      const ctx = await manager.getContext(id);
      const inputs: DraftInputs = {
        specClauses: ctx.specClauses ?? [],
        filePaths: ctx.files.map((f) => f.path),
      };
      const summary = await runDraft(inputs, dir, opts, deps);
      // Wire ontologyDir if not yet set so detection picks up the saved defs.
      if (!project.ontologyDir) {
        (project as { ontologyDir?: string }).ontologyDir = dir;
        await manager.save();
      }
      manager.cache.invalidate(project.id);
      return c.json({ project: project.id, dir, ...summary });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // GET /api/flow/drafts — list drafts from an explicit dir.
  app.get("/api/flow/drafts", async (c) => {
    const dir = c.req.query("dir");
    if (!dir) return c.json({ error: "dir query param is required" }, 400);
    const defs = await loadEditableDomains(dir);
    return c.json({ dir, domains: defs });
  });

  // POST /api/flow/draft — repo-path-based or spec-file-based draft (no project required).
  app.post("/api/flow/draft", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }

    const repoPath = typeof body["repoPath"] === "string" ? body["repoPath"] : null;
    const specPath = typeof body["specPath"] === "string" ? body["specPath"] : null;

    if (!repoPath && !specPath) {
      return c.json(
        {
          error:
            "repoPath or specPath is required. " +
            "For a registered project use POST /api/projects/:id/flow/draft instead.",
        },
        400,
      );
    }

    const dir =
      (typeof body["dir"] === "string" ? body["dir"] : null) ??
      (repoPath ? domainsDir(repoPath) : null);
    if (!dir) {
      return c.json(
        { error: "dir is required when specPath is used without repoPath" },
        400,
      );
    }

    const opts = parseDraftOpts(body);

    try {
      let inputs: DraftInputs;
      if (repoPath) {
        const ctx = await analyze(repoPath, { quiet: true });
        inputs = {
          specClauses: ctx.specClauses ?? [],
          filePaths: ctx.files.map((f) => f.path),
        };
      } else {
        // specPath mode: parse a single spec file; no module map.
        const clauses = await parseMdFile(specPath!);
        inputs = { specClauses: clauses, filePaths: [] };
      }
      const summary = await runDraft(inputs, dir, opts, deps);
      return c.json({ dir, ...summary });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveProject(manager: ProjectManager, id: string) {
  try {
    const projectId = manager.resolveId(id);
    return manager.get(projectId) ?? null;
  } catch {
    return null;
  }
}

function parseDraftOpts(body: Record<string, unknown>): DraftOpts {
  return {
    noLlm: body["noLlm"] === true,
    only: Array.isArray(body["only"])
      ? (body["only"] as unknown[]).map(String).filter(Boolean)
      : [],
    force: body["force"] === true,
  };
}

async function runDraft(
  inputs: DraftInputs,
  dir: string,
  opts: DraftOpts,
  deps: FlowRouteDeps,
): Promise<DraftSummary> {
  let drafts: DomainDraft[] = opts.noLlm
    ? seedDraftsFromStructure(inputs)
    : await synthesizeDraftsOrFail(inputs, deps);

  if (opts.only.length) {
    const want = new Set(opts.only);
    drafts = drafts.filter((d) => want.has(d.name));
  }

  const existing = await loadEditableDomains(dir);
  const reconciled = reconcileDrafts(existing, drafts, { force: opts.force });
  await saveEditableDomains(dir, reconciled.merged);

  return {
    drafted: drafts.length,
    added: reconciled.added,
    updated: reconciled.updated,
    preserved: reconciled.preserved,
    total: reconciled.merged.length,
  };
}

/**
 * Run synthesizeDomainDrafts with the injected LLM, or throw a descriptive error
 * if no real LLM is available. Never silently falls back to the skeleton seed.
 */
async function synthesizeDraftsOrFail(
  inputs: DraftInputs,
  deps: FlowRouteDeps,
): Promise<DomainDraft[]> {
  if (!deps.draftLlm || deps.draftModelId === "stub-llm") {
    throw new Error(
      "draft synthesis requires a real LLM. " +
        "LUDIARS uses the claude CLI (claude -p, no API key) — " +
        "ensure `claude` is on PATH or set ANATOMIA_LLM_BACKEND to a non-stub backend. " +
        "Pass noLlm=true to use the deterministic skeleton seed instead.",
    );
  }
  return synthesizeDomainDrafts(inputs, deps.draftLlm, deps.draftCache, deps.draftModelId);
}
