// @spec リファクタリング提案生成 + 調整タスク発行 (task sink)

import type { Hono } from "hono";
import type { ProjectManager } from "../../../project/manager.js";
import { knowledgePortFromManager } from "../../../knowledge/application/manager-port.js";
import { RefactoringTaskService, type RefactoringTaskSink } from "../../../knowledge/refactoring-tasks.js";
import { configuredRefactoringTaskSink } from "../../refactoring-task-sink.js";
import { readWebView } from "../../../web-cache/store.js";
import type { ProgramDomainViewPayload } from "../../../web-cache/types.js";

export function mountRefactoringTaskRoutes(app: Hono, deps: { manager: ProjectManager | null; sink?: RefactoringTaskSink }): void {
  app.post("/api/projects/:id/refactoring-tasks", async (c) => {
    if (!deps.manager) return c.json({ error: "refactoring tasks require manager mode" }, 501);
    let projectId: string;
    try { projectId = deps.manager.resolveId(c.req.param("id")); } catch { return c.json({ error: "unknown project" }, 404); }
    let body: { confirm?: unknown; proposalId?: unknown };
    try {
      body = await c.req.json() as { confirm?: unknown; proposalId?: unknown };
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    if (body?.confirm !== true) return c.json({ error: "human_confirmation_required: confirm must be true" }, 409);
    if (typeof body.proposalId !== "string") return c.json({ error: "proposalId must be a string" }, 400);
    const cached = await readWebView<ProgramDomainViewPayload>(deps.manager.cache.dirFor(projectId), "program-domain-view");
    if (!cached) return c.json({ error: "not-prepared", view: "program-domain-view" }, 409);
    const proposals = Array.isArray(cached.data.proposals) ? cached.data.proposals : [];
    const proposal = proposals.find((candidate) => candidate.proposalId === body.proposalId);
    if (!proposal) return c.json({ error: "proposal is not active" }, 409);
    try {
      const service = new RefactoringTaskService(knowledgePortFromManager(deps.manager, projectId), deps.sink ?? configuredRefactoringTaskSink());
      return c.json({ proposalId: proposal.proposalId, task: await service.issue(proposal) });
    } catch {
      // Do not expose sink URLs, local knowledge-log paths, or other adapter
      // details through the public HTTP response.
      return c.json({ error: "refactoring task issuance failed" }, 503);
    }
  });
}
