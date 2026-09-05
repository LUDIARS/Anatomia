/**
 * src/adapters/web/routes/plan.ts — `POST /api/plan` (design §3.4 / A-4).
 *
 * The warm server's copy of `anatomia plan`, so the Castra supply hook can
 * prefix a coding prompt with the domain plan without paying for a cold CLI
 * analysis on every prompt.
 *
 * `llm` DEFAULTS TO TRUE (design §5: "hook は決定的フォールバックではなく
 * Anatomia plan (LLM 分解) 前提。POST /api/plan の既定は llm=true"). One
 * decomposition costs ~10s and the design accepts that per coding prompt; a
 * caller that cannot wait passes `llm: false` and gets the deterministic
 * decomposition, which the response labels via `plan.source`.
 *
 * SRP: HTTP shaping for the plan pipeline. No planning logic here.
 */

import type { Hono } from "hono";
import type { ProjectManager } from "../../../project/manager.js";
import { effectiveOntologyDir } from "../../../project/config-paths.js";
import {
  buildPlan,
  formatPlan,
  formatPlanOkf,
  savePlan,
  type PlanRepo,
} from "../../../supply/plan/index.js";

interface PlanRequestBody {
  /** Primary project id. */
  project?: unknown;
  /** Additional project ids for a cross-repo plan. */
  projects?: unknown;
  task?: unknown;
  /** Run the LLM decomposition. Default true. */
  llm?: unknown;
  /** Also render the OKF document (for delegation prompts). */
  okf?: unknown;
}

/** Mount `POST /api/plan`. */
export function mountPlanRoutes(app: Hono, deps: { manager: ProjectManager | null }): void {
  app.post("/api/plan", async (c) => {
    // Legacy single-context mode has no registry, so there is no project id to
    // plan for; say so instead of planning against an unrelated context.
    const manager = deps.manager;
    if (!manager) return c.json({ error: "plan requires manager mode" }, 501);

    let parsed: unknown;
    try {
      parsed = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    if (!isPlanRequestBody(parsed)) return c.json({ error: "body must be a JSON object" }, 400);
    const body = parsed;

    const task = typeof body.task === "string" ? body.task.trim() : "";
    if (task === "") return c.json({ error: "task is required" }, 400);

    const requested = [
      ...(typeof body.project === "string" ? [body.project] : []),
      ...(Array.isArray(body.projects)
        ? body.projects.filter((p): p is string => typeof p === "string")
        : []),
    ];
    if (requested.length === 0) return c.json({ error: "project is required" }, 400);

    const repos: PlanRepo[] = [];
    for (const requestedId of [...new Set(requested)]) {
      let id: string;
      try {
        id = manager.resolveId(requestedId);
      } catch {
        return c.json({ error: `no such project "${requestedId}"` }, 404);
      }
      const project = manager.get(id)!;
      repos.push({
        id,
        repoPath: project.rootPath,
        ctx: await manager.getContext(id),
        ontologyDir: effectiveOntologyDir(project),
      });
    }

    const plan = await buildPlan(task, repos, { noLlm: body.llm === false });
    const { failed } = await savePlan(
      plan,
      repos.map((repo) => ({ id: repo.id, repoPath: repo.repoPath })),
    );
    for (const failure of failed) {
      plan.notes.push(`plan を保存できませんでした (${failure.path}): ${failure.reason}`);
    }

    return c.json({
      plan,
      markdown: formatPlan(plan),
      ...(body.okf === true ? { okf: formatPlanOkf(plan) } : {}),
    });
  });
}

function isPlanRequestBody(value: unknown): value is PlanRequestBody {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
