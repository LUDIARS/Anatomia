import type { Hono } from "hono";
import type { ProjectManager } from "../../../project/manager.js";
import { KnowledgeApplicationService, knowledgePortFromManager } from "../../../knowledge/application/index.js";
import type { GateARequest } from "../../../knowledge/domain/gate-a.js";
import type { GateBRequest } from "../../../knowledge/domain/gate-b.js";
import type { GateCRequest } from "../../../knowledge/domain/gate-c.js";
import type { DomainDriftInput } from "../../../knowledge/domain/drift.js";
import { domainOrganizationPage } from "../domain-organization-page.js";

function service(manager: ProjectManager, requestedId: string): KnowledgeApplicationService {
  return new KnowledgeApplicationService(knowledgePortFromManager(manager, requestedId));
}

function errorStatus(error: unknown): 400 | 404 | 409 {
  if (/unknown project|no such project/i.test(String(error))) return 404;
  return (error as { statusCode?: number }).statusCode === 409 || /conflict|stale|already approved/i.test(String(error)) ? 409 : 400;
}

/** Thin HTTP adapter over the shared domain command/query application service. */
export function mountDomainOrganizationRoutes(app: Hono, manager: ProjectManager | null): void {
  app.get("/domain-organization/:id", (c) => c.html(domainOrganizationPage(c.req.param("id"))));

  app.get("/api/projects/:id/domain-organization", async (c) => {
    if (!manager) return c.json({ error: "project management requires manager mode" }, 501);
    try { return c.json(await service(manager, c.req.param("id")).domains.query()); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, errorStatus(error)); }
  });

  app.get("/api/projects/:id/knowledge/status", async (c) => {
    if (!manager) return c.json({ error: "project management requires manager mode" }, 501);
    try { return c.json(await service(manager, c.req.param("id")).status()); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, errorStatus(error)); }
  });

  app.post("/api/projects/:id/knowledge/migration/plan", async (c) => {
    if (!manager) return c.json({ error: "project management requires manager mode" }, 501);
    try { return c.json(await service(manager, c.req.param("id")).planLegacyMigration()); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, errorStatus(error)); }
  });

  app.post("/api/projects/:id/knowledge/migration/apply", async (c) => {
    if (!manager) return c.json({ error: "project management requires manager mode" }, 501);
    try {
      const application = service(manager, c.req.param("id"));
      const body = await c.req.json() as Record<string, unknown>;
      if ("plan" in body) throw new Error("migration plan is server-generated; submit only its reviewed fingerprint and head");
      if (typeof body["expectedSourceFingerprint"] !== "string" || !("expectedHead" in body)) {
        throw new Error("expectedSourceFingerprint and expectedHead are required");
      }
      const expectedHead = body["expectedHead"];
      if (expectedHead !== null && typeof expectedHead !== "string") throw new Error("expectedHead must be a string or null");
      return c.json(await application.applyLegacyMigration({ confirmApply: body["confirmApply"] === true,
        expectedSourceFingerprint: body["expectedSourceFingerprint"], expectedHead }));
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, errorStatus(error)); }
  });

  app.post("/api/projects/:id/domain-organization/proposals/spec", async (c) => {
    if (!manager) return c.json({ error: "project management requires manager mode" }, 501);
    try { return c.json(await service(manager, c.req.param("id")).domains.proposeFromSpec()); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, errorStatus(error)); }
  });

  app.post("/api/projects/:id/domain-organization/proposals/assignment", async (c) => {
    if (!manager) return c.json({ error: "project management requires manager mode" }, 501);
    try {
      const body = await c.req.json() as { anchorId?: string; domainId?: string };
      if (!body.anchorId || !body.domainId) throw new Error("anchorId and domainId are required");
      return c.json(await service(manager, c.req.param("id")).domains.proposeAssignment(body.anchorId, body.domainId));
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, errorStatus(error)); }
  });

  app.post("/api/projects/:id/domain-organization/proposals/reconciliation", async (c) => {
    if (!manager) return c.json({ error: "project management requires manager mode" }, 501);
    try {
      const body = await c.req.json() as { inputs?: DomainDriftInput[] };
      if (!Array.isArray(body.inputs)) throw new Error("inputs must be an array");
      return c.json(await service(manager, c.req.param("id")).domains.proposeReconciliation(body.inputs));
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, errorStatus(error)); }
  });

  app.post("/api/projects/:id/domain-organization/gate-a", async (c) => {
    if (!manager) return c.json({ error: "project management requires manager mode" }, 501);
    try {
      const body = await c.req.json() as Pick<GateARequest, "confirmApply" | "proposals" | "hierarchy" | "expectedHead" | "reviewRef">;
      return c.json(await service(manager, c.req.param("id")).domains.gateA(body));
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, errorStatus(error)); }
  });

  app.post("/api/projects/:id/domain-organization/gate-b", async (c) => {
    if (!manager) return c.json({ error: "project management requires manager mode" }, 501);
    try {
      const body = await c.req.json() as Pick<GateBRequest, "confirmApply" | "actions" | "expectedHead" | "codeRevision" | "reviewRef">;
      return c.json(await service(manager, c.req.param("id")).domains.gateB(body));
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, errorStatus(error)); }
  });

  app.post("/api/projects/:id/domain-organization/gate-c", async (c) => {
    if (!manager) return c.json({ error: "project management requires manager mode" }, 501);
    try {
      const body = await c.req.json() as Omit<GateCRequest,
        "repoRoot" | "workflowRoot" | "knowledgeLogPath" | "sourceRevision" | "analysisSnapshotId" | "residualAnalysis">;
      return c.json(await service(manager, c.req.param("id")).domains.gateC(body));
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, errorStatus(error)); }
  });
}
