import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Hono } from "hono";
import { ProjectManager } from "../../../project/manager.js";
import { resolveKnowledgeWriteRoot } from "../../../knowledge/write-root.js";
import { replayKnowledgeLog } from "../../../knowledge/log.js";
import { proposeDomainsFromSpec } from "../../../knowledge/domain/spec-proposals.js";
import { buildDomainOrganizationView } from "../../../knowledge/domain/organization-view.js";
import { applyGateA, type GateARequest } from "../../../knowledge/domain/gate-a.js";
import { applyGateB, type GateBRequest } from "../../../knowledge/domain/gate-b.js";
import { applyGateC, type GateCRequest } from "../../../knowledge/domain/gate-c.js";
import { analyzeCodeAssignment } from "../../../knowledge/domain/assignments.js";
import {
  classifyDomainDrift,
  proposeSemanticDomainChanges,
  type DomainDriftInput,
} from "../../../knowledge/domain/drift.js";
import { describeCodeSymbol } from "../../../knowledge/code-symbol.js";
import type { CodeNode } from "../../../types.js";
import type { AnalyzedCodeSymbol } from "../../../knowledge/domain/organization-view.js";
import { domainOrganizationPage } from "../domain-organization-page.js";

async function readLog(path: string) {
  try { return replayKnowledgeLog(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return replayKnowledgeLog("");
    throw error;
  }
}

function paths(manager: ProjectManager, id: string) {
  const projectId = manager.resolveId(id);
  const project = manager.get(projectId)!;
  const writeRoot = resolveKnowledgeWriteRoot(project);
  return {
    projectId,
    project,
    writeRoot,
    domainRoot: join(writeRoot, "data", "domains"),
    knowledgeLogPath: join(writeRoot, "data", "domain-map", `${projectId}.knowledge.jsonl`),
  };
}

async function revisions(manager: ProjectManager, projectId: string) {
  const fingerprint = await manager.fingerprint(projectId);
  return { sourceRevision: `sha256:${fingerprint}`, analysisSnapshotId: `analysis:${fingerprint}` };
}

function residual(manager: ProjectManager, projectId: string) {
  return async () => {
    manager.cache.invalidate(projectId);
    const context = await manager.analyzeProject(projectId);
    return { clauses: context.specClauses?.length ?? 0, codeSymbols: (await context.graph.allNodes()).length };
  };
}

function resolveOkfWrites(writeRoot: string, writes: GateCRequest["okfWrites"]): GateCRequest["okfWrites"] {
  if (!Array.isArray(writes)) throw new Error("okfWrites must be an array");
  const root = resolve(writeRoot);
  return writes.map((write) => {
    if (typeof write?.path !== "string" || write.path === "") throw new Error("okfWrites entries require a path");
    // The write root itself is a directory, so containment must be strict: only
    // paths BELOW it are writable targets.
    const path = resolve(root, write.path);
    if (!path.startsWith(`${root}${sep}`)) {
      throw new Error(`semantic OKF path escapes knowledgeWriteRoot: ${write.path}`);
    }
    return { ...write, path };
  });
}

function organizationSymbols(
  projectId: string,
  projectRoot: string,
  nodes: Iterable<CodeNode>,
  sourceRevision: string,
): AnalyzedCodeSymbol[] {
  return [...nodes]
    .filter((node) => node.id !== null)
    .map((node) => {
      const symbol = describeCodeSymbol(projectId, projectRoot, node, sourceRevision);
      return {
        id: symbol.symbolId,
        anchorId: symbol.anchorId,
        qualifiedName: symbol.qualifiedName,
        sourcePath: symbol.sourcePath,
        sourceRange: { startLine: symbol.startLine, endLine: symbol.endLine },
      };
    });
}

/**
 * One error contract for the whole surface: an unregistered project is 404 like
 * the rest of the project API, a lost race on the knowledge head is 409 so the
 * UI can re-read instead of retrying, and everything else is a 400 request fault.
 */
function failure(error: unknown, gate = false): { error: string; status: 400 | 404 | 409 } {
  const message = error instanceof Error ? error.message : String(error);
  if (/unknown project/i.test(message)) return { error: message, status: 404 };
  const conflict = (error as { statusCode?: number }).statusCode === 409
    || /conflict|stale|already approved/i.test(message);
  return { error: message, status: gate && conflict ? 409 : 400 };
}

/** Domain canvas and every write command share the same canonical Gate services. */
export function mountDomainOrganizationRoutes(app: Hono, manager: ProjectManager | null): void {
  app.get("/domain-organization/:id", (c) => c.html(domainOrganizationPage(c.req.param("id"))));

  app.get("/api/projects/:id/domain-organization", async (c) => {
    if (!manager) return c.json({ error: "project management requires manager mode" }, 501);
    try {
      const resolved = paths(manager, c.req.param("id"));
      const context = await manager.getContext(resolved.projectId);
      const revision = await revisions(manager, resolved.projectId);
      const codeNodes = await context.graph.allNodes();
      return c.json(buildDomainOrganizationView(
        await readLog(resolved.knowledgeLogPath),
        organizationSymbols(
          resolved.projectId,
          resolved.project.rootPath,
          codeNodes,
          revision.sourceRevision,
        ),
      ));
    } catch (error) {
      const failed = failure(error);
      return c.json({ error: failed.error }, failed.status);
    }
  });

  app.post("/api/projects/:id/domain-organization/proposals/spec", async (c) => {
    if (!manager) return c.json({ error: "project management requires manager mode" }, 501);
    try {
      const resolved = paths(manager, c.req.param("id"));
      const context = await manager.getContext(resolved.projectId);
      const revision = await revisions(manager, resolved.projectId);
      const state = await readLog(resolved.knowledgeLogPath);
      const proposals = proposeDomainsFromSpec({
        projectId: resolved.projectId,
        clauses: context.specClauses ?? [],
        ...revision,
        expectedHead: state.head,
      });
      return c.json({ proposals, ...revision, expectedHead: state.head });
    } catch (error) {
      const failed = failure(error);
      return c.json({ error: failed.error }, failed.status);
    }
  });

  app.post("/api/projects/:id/domain-organization/proposals/assignment", async (c) => {
    if (!manager) return c.json({ error: "project management requires manager mode" }, 501);
    try {
      const resolved = paths(manager, c.req.param("id"));
      const body = await c.req.json() as { anchorId?: string; domainId?: string };
      if (!body.anchorId || !body.domainId) throw new Error("anchorId and domainId are required");
      const context = await manager.getContext(resolved.projectId);
      const codeNode = (await context.graph.allNodes()).find((node) => node.id === body.anchorId);
      if (!codeNode) throw new Error(`unknown code anchor ${body.anchorId}`);
      const revision = await revisions(manager, resolved.projectId);
      const state = await readLog(resolved.knowledgeLogPath);
      const symbol = describeCodeSymbol(resolved.projectId, resolved.project.rootPath, codeNode, revision.sourceRevision);
      const beforeOwner = [...state.edges.values()]
        .find((edge) => edge.kind === "domain-owns-code" && edge.to === symbol.symbolId)?.from ?? null;
      const { anchorId: _anchorId, ...evidence } = symbol;
      const action = analyzeCodeAssignment(evidence, [{
        domainId: body.domainId,
        evidence: [{
          kind: "explicit-annotation",
          detail: "human selection in domain organization review",
          confidence: 1,
          sourceAnchor: String(codeNode.id),
        }],
      }], beforeOwner, revision.analysisSnapshotId, state.head);
      return c.json({ action, expectedHead: state.head, codeRevision: revision.sourceRevision });
    } catch (error) {
      const failed = failure(error);
      return c.json({ error: failed.error }, failed.status);
    }
  });

  app.post("/api/projects/:id/domain-organization/proposals/reconciliation", async (c) => {
    if (!manager) return c.json({ error: "project management requires manager mode" }, 501);
    try {
      const resolved = paths(manager, c.req.param("id"));
      const body = await c.req.json() as { inputs?: DomainDriftInput[] };
      if (!Array.isArray(body.inputs)) throw new Error("inputs must be an array");
      const revision = await revisions(manager, resolved.projectId);
      const state = await readLog(resolved.knowledgeLogPath);
      const findings = body.inputs.flatMap(classifyDomainDrift);
      const proposals = proposeSemanticDomainChanges(findings, {
        ...revision,
        expectedHead: state.head,
      });
      return c.json({ findings, proposals, ...revision, expectedHead: state.head });
    } catch (error) {
      const failed = failure(error);
      return c.json({ error: failed.error }, failed.status);
    }
  });

  app.post("/api/projects/:id/domain-organization/gate-a", async (c) => {
    if (!manager) return c.json({ error: "project management requires manager mode" }, 501);
    try {
      const resolved = paths(manager, c.req.param("id"));
      const body = await c.req.json() as Pick<GateARequest, "confirmApply" | "proposals" | "hierarchy" | "expectedHead" | "reviewRef">;
      const revision = await revisions(manager, resolved.projectId);
      const result = await applyGateA({
        ...body,
        ...revision,
        repoRoot: resolved.project.rootPath,
        service: resolved.projectId,
        domainRoot: resolved.domainRoot,
        knowledgeLogPath: resolved.knowledgeLogPath,
      });
      return c.json(result);
    } catch (error) {
      const failed = failure(error, true);
      return c.json({ error: failed.error }, failed.status);
    }
  });

  app.post("/api/projects/:id/domain-organization/gate-b", async (c) => {
    if (!manager) return c.json({ error: "project management requires manager mode" }, 501);
    try {
      const resolved = paths(manager, c.req.param("id"));
      const body = await c.req.json() as Pick<GateBRequest, "confirmApply" | "actions" | "expectedHead" | "codeRevision" | "reviewRef">;
      const revision = await revisions(manager, resolved.projectId);
      return c.json(await applyGateB({
        ...body,
        repoRoot: resolved.project.rootPath,
        knowledgeLogPath: resolved.knowledgeLogPath,
        analysisSnapshotId: revision.analysisSnapshotId,
        residualAnalysis: residual(manager, resolved.projectId),
      }));
    } catch (error) {
      const failed = failure(error, true);
      return c.json({ error: failed.error }, failed.status);
    }
  });

  app.post("/api/projects/:id/domain-organization/gate-c", async (c) => {
    if (!manager) return c.json({ error: "project management requires manager mode" }, 501);
    try {
      const resolved = paths(manager, c.req.param("id"));
      const body = await c.req.json() as Omit<
        GateCRequest,
        "repoRoot" | "workflowRoot" | "knowledgeLogPath" | "sourceRevision" | "analysisSnapshotId" | "residualAnalysis"
      >;
      const revision = await revisions(manager, resolved.projectId);
      return c.json(await applyGateC({
        ...body,
        okfWrites: resolveOkfWrites(resolved.writeRoot, body.okfWrites),
        ...revision,
        repoRoot: resolved.project.rootPath,
        workflowRoot: resolved.writeRoot,
        knowledgeLogPath: resolved.knowledgeLogPath,
        residualAnalysis: residual(manager, resolved.projectId),
      }));
    } catch (error) {
      const failed = failure(error, true);
      return c.json({ error: failed.error }, failed.status);
    }
  });
}
