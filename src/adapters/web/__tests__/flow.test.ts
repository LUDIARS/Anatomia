import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnalysisContext } from "../../../core.js";
import {
  domainsDir,
  draftToEditableDef,
  saveEditableDomains,
  type DomainDraft,
} from "../../../domains/authoring/index.js";
import * as domainWorkflow from "../../../domains/workflow/index.js";
import type { ProjectManager } from "../../../project/manager.js";
import { mountFlowRoutes } from "../routes/flow.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "anatomia-flow-"));
  roots.push(root);
  return root;
}

function request(app: Hono, path: string, body: Record<string, unknown>): Promise<Response> {
  return Promise.resolve(app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function managerFor(root: string, context: AnalysisContext) {
  const project = { id: "demo", name: "demo", rootPath: root } as {
    id: string;
    name: string;
    rootPath: string;
    ontologyDir?: string;
  };
  const save = vi.fn(async () => undefined);
  const invalidate = vi.fn();
  const getContext = vi.fn(async () => context);
  const manager = {
    resolveId: (id: string) => id,
    get: (id: string) => (id === "demo" ? project : undefined),
    getContext,
    save,
    cache: { invalidate },
  } as unknown as ProjectManager;
  return { manager, project, save, invalidate, getContext };
}

function emptyContext(root: string): AnalysisContext {
  return {
    repoPath: root,
    graph: {} as AnalysisContext["graph"],
    files: [],
    functions: [],
    domains: [],
    specClauses: [],
  } as AnalysisContext;
}

function mockGateBApply(): void {
  vi.spyOn(domainWorkflow, "requireGateAApproval").mockResolvedValue({} as never);
  vi.spyOn(domainWorkflow, "approveAndApplyOrphanDomains").mockResolvedValue({
    definitions: [],
    writtenSpecs: [],
    writtenDomains: [],
    gate: { version: 1, baselineSnapshotId: "baseline", ontologySnapshotId: "ontology" },
  } as Awaited<ReturnType<typeof domainWorkflow.approveAndApplyOrphanDomains>>);
}

describe("domain discovery flow routes", () => {
  it("keeps the direct spec draft route proposal-only", async () => {
    const root = await tempRoot();
    const specPath = join(root, "feature.md");
    const outputDir = join(root, "domains");
    await writeFile(specPath, "# Combat\n\nResolve attacks.\n", "utf8");
    const app = new Hono();
    mountFlowRoutes(app, { manager: null });

    const response = await request(app, "/api/flow/draft", {
      specPath,
      dir: outputDir,
      noLlm: true,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["snapshotId"]).toMatch(/^[a-f0-9]{64}$/);
    expect(body["proposalId"]).toMatch(/^[a-f0-9]{64}$/);
    expect(body["drafts"]).toBeInstanceOf(Array);
    await expect(access(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires confirmation and a current snapshot before Gate A writes", async () => {
    const root = await tempRoot();
    const context = {
      repoPath: root,
      graph: {} as AnalysisContext["graph"],
      files: [],
      functions: [],
      domains: [],
      specClauses: [
        {
          id: "SPEC-COMBAT",
          heading: "Combat",
          text: "Resolve attacks.",
          sourceFile: join(root, "spec", "combat.md"),
          embedding: [],
        },
      ],
    } as AnalysisContext;
    const { manager, project, save, invalidate } = managerFor(root, context);
    const app = new Hono();
    mountFlowRoutes(app, { manager });

    const premature = await app.request("/api/projects/demo/flow/orphans");
    expect(premature.status).toBe(409);

    const proposed = await request(app, "/api/projects/demo/flow/draft", { noLlm: true });
    expect(proposed.status).toBe(200);
    const proposal = (await proposed.json()) as {
      snapshotId: string;
      drafts: unknown[];
    };

    const denied = await request(app, "/api/projects/demo/flow/apply", {
      snapshotId: proposal.snapshotId,
      drafts: proposal.drafts,
    });
    expect(denied.status).toBe(409);
    expect(project.ontologyDir).toBeUndefined();

    const stale = await request(app, "/api/projects/demo/flow/apply", {
      confirmApply: true,
      snapshotId: "stale",
      drafts: proposal.drafts,
      overrideNames: [],
    });
    expect(stale.status).toBe(409);
    expect(project.ontologyDir).toBeUndefined();

    const outsideDir = join(root, "outside-requested-dir");
    const applied = await request(app, "/api/projects/demo/flow/apply", {
      confirmApply: true,
      snapshotId: proposal.snapshotId,
      drafts: proposal.drafts,
      overrideNames: [],
      dir: outsideDir,
    });
    expect(applied.status).toBe(200);
    expect(project.ontologyDir).toBe(join(root, ".anatomia", "domains"));
    await expect(access(outsideDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(save).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith("demo");

    const allowed = await app.request("/api/projects/demo/flow/orphans");
    expect(allowed.status).toBe(200);
  });

  it("requires per-domain overrides and rejects legacy lock controls", async () => {
    const root = await tempRoot();
    const context = {
      ...emptyContext(root),
      specClauses: [
        {
          id: "SPEC-COMBAT",
          heading: "Combat",
          text: "Resolve attacks.",
          sourceFile: join(root, "spec", "combat.md"),
          embedding: [],
        },
      ],
    } as AnalysisContext;
    const { manager, save } = managerFor(root, context);
    const app = new Hono();
    mountFlowRoutes(app, { manager });

    const initialResponse = await request(app, "/api/projects/demo/flow/draft", { noLlm: true });
    const initial = (await initialResponse.json()) as { drafts: DomainDraft[] };
    const seeded = initial.drafts[0]!;
    await saveEditableDomains(domainsDir(root), [{
      ...draftToEditableDef(seeded),
      description: "Human-owned combat rules.",
      source: "manual",
      lockedFields: ["*"],
      updatedAt: "2026-07-11T00:00:00.000Z",
    }]);

    const proposalResponse = await request(app, "/api/projects/demo/flow/draft", { noLlm: true });
    const proposal = (await proposalResponse.json()) as {
      snapshotId: string;
      drafts: DomainDraft[];
      overrideCandidates: string[];
    };
    expect(proposalResponse.status, JSON.stringify(proposal)).toBe(200);
    expect(proposal.overrideCandidates).toContain(seeded.name);
    const edited = proposal.drafts.map((draft) =>
      draft.name === seeded.name ? { ...draft, description: "Explicitly overridden." } : draft,
    );

    const missingArray = await request(app, "/api/projects/demo/flow/apply", {
      confirmApply: true,
      snapshotId: proposal.snapshotId,
      drafts: edited,
    });
    expect(missingArray.status).toBe(400);
    expect(await missingArray.json()).toMatchObject({ error: "overrideNames must be an array" });

    const legacy = await request(app, "/api/projects/demo/flow/apply", {
      confirmApply: true,
      snapshotId: proposal.snapshotId,
      drafts: edited,
      overrideNames: [],
      manualNames: [],
    });
    expect(legacy.status).toBe(400);
    expect(await legacy.json()).toMatchObject({ error: "manualNames_is_not_supported" });

    const forced = await request(app, "/api/projects/demo/flow/apply", {
      confirmApply: true,
      snapshotId: proposal.snapshotId,
      drafts: edited,
      overrideNames: [],
      force: true,
    });
    expect(forced.status).toBe(400);
    expect(await forced.json()).toMatchObject({ error: "global_force_is_not_supported" });

    const unapproved = await request(app, "/api/projects/demo/flow/apply", {
      confirmApply: true,
      snapshotId: proposal.snapshotId,
      drafts: edited,
      overrideNames: [],
    });
    expect(unapproved.status).toBe(409);
    expect(await unapproved.json()).toMatchObject({
      error: "explicit_domain_override_required",
      domains: [seeded.name],
    });
    expect(save).not.toHaveBeenCalled();

    const applied = await request(app, "/api/projects/demo/flow/apply", {
      confirmApply: true,
      snapshotId: proposal.snapshotId,
      drafts: edited,
      overrideNames: [seeded.name],
    });
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({
      next: "orphan-review",
      applied: {
        accepted: [],
        overridden: [seeded.name],
      },
    });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("renders explicit overrides and Gate A outcome categories in the manual UI", async () => {
    const html = await readFile(join(process.cwd(), "src", "adapters", "web", "public", "index.html"), "utf8");
    expect(html).toContain("data-flow-override-name");
    expect(html).toContain("overrideNames: overrideNames");
    expect(html).toContain("gateAResult.accepted");
    expect(html).toContain("gateAResult.preserved");
    expect(html).toContain("gateAResult.overridden");
  });

  it("requires Gate B confirmation before writing generated specs", async () => {
    const root = await tempRoot();
    const context = {
      repoPath: root,
      graph: {} as AnalysisContext["graph"],
      files: [],
      functions: [],
      domains: [],
      specClauses: [],
    } as AnalysisContext;
    const { manager } = managerFor(root, context);
    const app = new Hono();
    mountFlowRoutes(app, { manager });

    const response = await request(app, "/api/projects/demo/flow/orphan-apply", {
      snapshotId: "snapshot",
      proposals: [],
    });
    expect(response.status).toBe(409);
    await expect(access(join(root, "spec"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns 409 when Gate B evidence changes while waiting for the workflow lock", async () => {
    const root = await tempRoot();
    const { manager } = managerFor(root, emptyContext(root));
    vi.spyOn(domainWorkflow, "approveAndApplyOrphanDomains").mockRejectedValueOnce(
      new domainWorkflow.OrphanApprovalConflictError("analysis", "reviewed", "current"),
    );
    const app = new Hono();
    mountFlowRoutes(app, { manager });

    const response = await request(app, "/api/projects/demo/flow/orphan-apply", {
      confirmApply: true,
      snapshotId: "reviewed",
      proposals: [],
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "stale_orphan_proposal",
      dimension: "analysis",
      expectedSnapshot: "reviewed",
      actualSnapshot: "current",
    });
  });

  it("reports registry sync separately after Gate B files and marker are applied", async () => {
    const root = await tempRoot();
    const context = emptyContext(root);
    const { manager, save } = managerFor(root, context);
    mockGateBApply();
    save.mockRejectedValueOnce(new Error("registry unavailable"));
    const app = new Hono();
    mountFlowRoutes(app, { manager });

    const inspected = await app.request("/api/projects/demo/flow/orphans");
    const investigation = (await inspected.json()) as { investigation: { snapshotId: string } };
    const response = await request(app, "/api/projects/demo/flow/orphan-apply", {
      confirmApply: true,
      snapshotId: investigation.investigation.snapshotId,
      proposals: [],
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      next: "registry-sync-required",
      recovery: "registry-sync",
    });
  });

  it("leaves Gate marker refresh inside the atomic Gate B service", async () => {
    const root = await tempRoot();
    const context = emptyContext(root);
    const { manager } = managerFor(root, context);
    mockGateBApply();
    const saveGate = vi.spyOn(domainWorkflow, "saveGateAApproval");
    const app = new Hono();
    mountFlowRoutes(app, { manager });

    const inspected = await app.request("/api/projects/demo/flow/orphans");
    const investigation = (await inspected.json()) as { investigation: { snapshotId: string } };
    const response = await request(app, "/api/projects/demo/flow/orphan-apply", {
      confirmApply: true,
      snapshotId: investigation.investigation.snapshotId,
      proposals: [],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ next: "complete" });
    expect(saveGate).not.toHaveBeenCalled();
  });

  it("only guides post-gate analysis failures to orphan reinspection", async () => {
    const root = await tempRoot();
    const context = emptyContext(root);
    const { manager, getContext } = managerFor(root, context);
    mockGateBApply();
    const app = new Hono();
    mountFlowRoutes(app, { manager });

    const inspected = await app.request("/api/projects/demo/flow/orphans");
    const investigation = (await inspected.json()) as { investigation: { snapshotId: string } };
    getContext.mockRejectedValueOnce(new Error("analysis unavailable"));
    const response = await request(app, "/api/projects/demo/flow/orphan-apply", {
      confirmApply: true,
      snapshotId: investigation.investigation.snapshotId,
      proposals: [],
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      next: "orphan-reinspection-required",
      recovery: "orphan-reinspection",
    });
  });
});
