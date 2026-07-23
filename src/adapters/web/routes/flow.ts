/**
 * src/adapters/web/routes/flow.ts — 学習フロー routes (domain draft authoring via HTTP).
 *
 * Routes:
 *   POST /api/projects/:id/flow/draft  — propose domains for a registered project
 *   POST /api/projects/:id/flow/apply  — Gate A: explicitly apply edited proposals
 *   GET  /api/projects/:id/flow/drafts — list current editable domains for a project
 *   POST /api/flow/draft               — repo-path/spec-file proposal (read-only)
 *   GET  /api/flow/drafts              — list drafts from an explicit dir (?dir=)
 *
 * The "学習フロー" first returns a read-only proposal. Persistence is a separate
 * apply route requiring explicit human confirmation and a matching analysis
 * snapshot, so an LLM response can never silently overwrite the ontology.
 *
 * Input modes (priority order for /api/flow/draft):
 *   repoPath  — full repo analysis; specClauses + filePaths from analyze()
 *   specPath  — parse a single spec file; specClauses only, filePaths=[]
 *
 * SRP: HTTP shaping + LLM/cache wiring. Synthesis stays in domains/authoring/.
 */

import { createHash } from "node:crypto";
import type { Hono } from "hono";
import type { ProjectManager } from "../../../project/manager.js";
import type { LLMClient } from "../../../domains/card.js";
import type { SpecClause } from "../../../types.js";
import {
  domainsDir,
  loadEditableDomains,
  synthesizeDomainDrafts,
  seedDraftsFromStructure,
  reconcileDrafts,
  type DraftCache,
  type DomainDraft,
  type EditableDomainDef,
} from "../../../domains/authoring/index.js";
import {
  investigateOrphanFunctions,
  type OrphanFunctionLocation,
} from "../../../domains/discovery/index.js";
import {
  applyGateAApproval,
  approveAndApplyOrphanDomains,
  DomainDiscoveryGateError,
  GateAApprovalConflictError,
  GateAOverrideRequiredError,
  orphanSpecSnapshotId,
  OrphanApprovalConflictError,
  requireGateAApproval,
  synthesizeOrphanDomainProposals,
  type ApprovedOrphanDomainProposal,
  type OrphanProposalCache,
} from "../../../domains/workflow/index.js";
import { parseMdFile } from "../../../spec/parse.js";
import { analyze, type AnalysisContext } from "../../../core.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FlowRouteDeps {
  manager: ProjectManager | null;
  /** Real LLM client for draft synthesis. Absent / stub → draft fails fast. */
  draftLlm?: LLMClient;
  draftModelId?: string;
  draftCache?: DraftCache;
  orphanProposalCache?: OrphanProposalCache;
}

interface DraftInputs {
  specClauses: SpecClause[];
  filePaths: string[];
  sourceAnchors: string[];
}

interface DraftOpts {
  noLlm: boolean;
  only: string[];
}

interface DraftProposal {
  snapshotId: string;
  proposalId: string;
  drafts: DomainDraft[];
  /** Existing locked domains that require an explicit per-domain override. */
  overrideCandidates: string[];
  preview: {
    added: string[];
    updated: string[];
    preserved: string[];
    total: number;
  };
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

  // POST /api/projects/:id/flow/draft — build a read-only proposal.
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
    const dir = project.ontologyDir ?? domainsDir(project.rootPath);

    try {
      const ctx = await manager.getContext(id);
      const inputs: DraftInputs = {
        specClauses: ctx.specClauses ?? [],
        filePaths: ctx.files.map((f) => f.path),
        sourceAnchors: ctx.functions.flatMap((fn) => (fn.id ? [String(fn.id)] : [])),
      };
      const proposal = await proposeDrafts(inputs, dir, opts, deps);
      return c.json({ project: project.id, dir, ...proposal });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // POST /api/projects/:id/flow/apply — Gate A: explicit, snapshot-checked apply.
  app.post("/api/projects/:id/flow/apply", async (c) => {
    if (!manager) return c.json({ error: "flow requires manager mode" }, 501);
    const id = c.req.param("id");
    const project = resolveProject(manager, id);
    if (!project) return c.json({ error: `no such project "${id}"` }, 404);

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    if (body["confirmApply"] !== true) {
      return c.json(
        {
          error: "human_confirmation_required",
          detail: "Review/edit the proposals, then set confirmApply:true.",
        },
        409,
      );
    }
    if (Object.prototype.hasOwnProperty.call(body, "manualNames")) {
      return c.json(
        {
          error: "manualNames_is_not_supported",
          detail:
            "manualNames cannot change Gate A locks. Send overrideNames as an explicit array instead.",
        },
        400,
      );
    }
    if (Object.prototype.hasOwnProperty.call(body, "force")) {
      return c.json(
        {
          error: "global_force_is_not_supported",
          detail: "Gate A does not allow a global force flag. Select each locked domain in overrideNames.",
        },
        400,
      );
    }

    try {
      const drafts = parseDomainDrafts(body["drafts"]);
      const overrideNames = parseOverrideNames(body["overrideNames"]);
      const expectedSnapshot = requiredString(body["snapshotId"], "snapshotId");
      const dir = project.ontologyDir ?? domainsDir(project.rootPath);
      const minGroupFunctions = positiveInteger(body["minGroupFunctions"], 3);
      const result = await applyGateAApproval({
        repoRoot: project.rootPath,
        ontologyDir: dir,
        expectedSnapshotId: expectedSnapshot,
        drafts,
        overrideNames,
        computeSnapshot: async (currentDefinitions) => {
          manager.cache.invalidate(project.id);
          const currentContext = await manager.getContext(project.id);
          return draftSnapshotId(
            draftInputsFromContext(currentContext),
            currentDefinitions,
          );
        },
      });

      project.ontologyDir = dir;
      const responseBase = {
        project: project.id,
        dir,
        applied: result.applied,
        gate: result.gate,
        writtenDomains: result.writtenDomainPaths,
      };
      try {
        await manager.save();
      } catch (registryError) {
        return c.json(
          {
            ...responseBase,
            next: "registry-sync-required",
            recovery: "registry-sync",
            warning:
              "Domains and the Gate A marker were applied, but project registry sync failed. " +
              `Persist project metadata before restart: ${errorMessage(registryError)}`,
          },
          202,
        );
      }
      try {
        manager.cache.invalidate(project.id);
        const nextContext = await manager.getContext(project.id);
        const orphans = await investigateProjectOrphans(
          nextContext,
          dir,
          minGroupFunctions,
        );
        return c.json({ ...responseBase, next: "orphan-review", orphans });
      } catch (reanalysisError) {
        return c.json(
          {
            ...responseBase,
            next: "orphan-reinspection-required",
            recovery: "orphan-reinspection",
            warning:
              "Domains and Gate A were applied, but orphan analysis failed. " +
              `Re-run orphan inspection: ${errorMessage(reanalysisError)}`,
          },
          202,
        );
      }
    } catch (err) {
      if (err instanceof GateAApprovalConflictError) {
        return c.json(
          {
            error: err.code,
            expectedSnapshot: err.expectedSnapshotId,
            actualSnapshot: err.actualSnapshotId,
            detail: "The spec, code, or domains changed; create a fresh proposal.",
          },
          409,
        );
      }
      if (err instanceof GateAOverrideRequiredError) {
        return c.json(
          {
            error: err.code,
            domains: err.domains,
            detail: "Select each edited locked domain in overrideNames before applying Gate A.",
          },
          409,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, flowErrorStatus(err));
    }
  });

  // GET /api/flow/drafts — list drafts from an explicit dir.
  app.get("/api/flow/drafts", async (c) => {
    const dir = c.req.query("dir");
    if (!dir) return c.json({ error: "dir query param is required" }, 400);
    const defs = await loadEditableDomains(dir);
    return c.json({ dir, domains: defs });
  });

  // GET /api/projects/:id/flow/orphans — deterministic, read-only investigation.
  app.get("/api/projects/:id/flow/orphans", async (c) => {
    if (!manager) return c.json({ error: "flow requires manager mode" }, 501);
    const id = c.req.param("id");
    const project = resolveProject(manager, id);
    if (!project) return c.json({ error: `no such project "${id}"` }, 404);
    try {
      const dir = project.ontologyDir ?? domainsDir(project.rootPath);
      await requireGateAApproval(project.rootPath, dir);
      const ctx = await manager.getContext(project.id);
      const minGroupFunctions = positiveInteger(c.req.query("minGroupFunctions"), 3);
      const investigation = await investigateProjectOrphans(ctx, dir, minGroupFunctions);
      return c.json({ project: project.id, investigation });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, flowErrorStatus(err));
    }
  });

  // POST orphan-proposals — LLM detail/spec drafts; still read-only.
  app.post("/api/projects/:id/flow/orphan-proposals", async (c) => {
    if (!manager) return c.json({ error: "flow requires manager mode" }, 501);
    const id = c.req.param("id");
    const project = resolveProject(manager, id);
    if (!project) return c.json({ error: `no such project "${id}"` }, 404);
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    try {
      const dir = project.ontologyDir ?? domainsDir(project.rootPath);
      await requireGateAApproval(project.rootPath, dir);
      const ctx = await manager.getContext(project.id);
      const investigation = await investigateProjectOrphans(
        ctx,
        dir,
        positiveInteger(body["minGroupFunctions"], 3),
      );
      const requestedSnapshot = requiredString(body["snapshotId"], "snapshotId");
      if (requestedSnapshot !== investigation.snapshotId) {
        return c.json(
          {
            error: "stale_orphan_investigation",
            requestedSnapshot,
            actualSnapshot: investigation.snapshotId,
          },
          409,
        );
      }
      if (investigation.candidateGroups.length === 0) {
        return c.json({ project: project.id, snapshotId: investigation.snapshotId, proposals: [] });
      }
      const llm = realLlmOrFail(deps);
      const proposals = await synthesizeOrphanDomainProposals(
        investigation,
        ctx.specClauses ?? [],
        llm,
        {
          groupIds: optionalStringArray(body["groupIds"], "groupIds"),
          modelId: deps.draftModelId,
          cache: deps.orphanProposalCache,
        },
      );
      return c.json({ project: project.id, snapshotId: investigation.snapshotId, proposals });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json(
        { error: message },
        message.includes("requires a real LLM") ? 501 : flowErrorStatus(err),
      );
    }
  });

  // POST orphan-apply — Gate B: save selected domain + human-supplemented specs.
  app.post("/api/projects/:id/flow/orphan-apply", async (c) => {
    if (!manager) return c.json({ error: "flow requires manager mode" }, 501);
    const id = c.req.param("id");
    const project = resolveProject(manager, id);
    if (!project) return c.json({ error: `no such project "${id}"` }, 404);
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    if (body["confirmApply"] !== true) {
      return c.json(
        {
          error: "human_confirmation_required",
          detail: "Review each generated spec, add humanSupplement, then set confirmApply:true.",
        },
        409,
      );
    }

    try {
      const approved = parseApprovedOrphanProposals(body["proposals"]);
      const requestedSnapshot = requiredString(body["snapshotId"], "snapshotId");
      const minGroupFunctions = positiveInteger(body["minGroupFunctions"], 3);
      const dir = project.ontologyDir ?? domainsDir(project.rootPath);
      const applied = await approveAndApplyOrphanDomains({
        repoRoot: project.rootPath,
        ontologyDir: dir,
        proposals: approved,
        analysisSnapshotId: requestedSnapshot,
        loadCurrentEvidence: async () => {
          manager.cache.invalidate(project.id);
          const currentContext = await manager.getContext(project.id);
          const currentInvestigation = await investigateProjectOrphans(
            currentContext,
            dir,
            minGroupFunctions,
          );
          return {
            analysisSnapshotId: currentInvestigation.snapshotId,
            specSnapshotId: orphanSpecSnapshotId(currentContext.specClauses ?? []),
            candidateGroups: currentInvestigation.candidateGroups,
          };
        },
      });

      project.ontologyDir = dir;
      const appliedSummary = {
        added: applied.definitions.map((definition) => definition.name),
        updated: [] as string[],
        accepted: applied.definitions.map((definition) => definition.name),
        preserved: [] as string[],
        overridden: [] as string[],
        total: applied.definitions.length,
      };
      const responseBase = {
        project: project.id,
        dir,
        applied: appliedSummary,
        writtenSpecs: applied.writtenSpecs,
        writtenDomains: applied.writtenDomains,
      };
      try {
        await manager.save();
      } catch (registryError) {
        return c.json(
          {
            ...responseBase,
            next: "registry-sync-required",
            recovery: "registry-sync",
            warning:
              "Domain/spec files and the refreshed Gate A marker were applied, but project registry sync failed. " +
              `Persist project metadata before restart: ${errorMessage(registryError)}`,
          },
          202,
        );
      }
      try {
        manager.cache.invalidate(project.id);
        const refreshed = await manager.getContext(project.id);
        const residual = await investigateProjectOrphans(refreshed, dir, minGroupFunctions);
        return c.json({
          ...responseBase,
          next: "complete",
          residual,
        });
      } catch (reanalysisError) {
        return c.json(
          {
            ...responseBase,
            next: "orphan-reinspection-required",
            recovery: "orphan-reinspection",
            warning:
              "Domain/spec files were applied and Gate A was refreshed, but residual analysis failed. " +
              `Re-run orphan inspection: ${errorMessage(reanalysisError)}`,
          },
          202,
        );
      }
    } catch (err) {
      if (err instanceof OrphanApprovalConflictError) {
        return c.json(
          {
            error: err.code,
            dimension: err.dimension,
            expectedSnapshot: err.expectedSnapshotId,
            actualSnapshot: err.actualSnapshotId,
          },
          409,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, flowErrorStatus(err));
    }
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
          sourceAnchors: ctx.functions.flatMap((fn) => (fn.id ? [String(fn.id)] : [])),
        };
      } else {
        // specPath mode: parse a single spec file; no module map.
        const clauses = await parseMdFile(specPath!);
        inputs = { specClauses: clauses, filePaths: [], sourceAnchors: [] };
      }
      const proposal = await proposeDrafts(inputs, dir, opts, deps);
      return c.json({ dir, ...proposal });
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
  };
}

async function proposeDrafts(
  inputs: DraftInputs,
  dir: string,
  opts: DraftOpts,
  deps: FlowRouteDeps,
): Promise<DraftProposal> {
  let drafts: DomainDraft[] = opts.noLlm
    ? seedDraftsFromStructure(inputs)
    : await synthesizeDraftsOrFail(inputs, deps);

  if (opts.only.length) {
    const want = new Set(opts.only);
    drafts = drafts.filter((d) => want.has(d.name));
  }

  const existing = await loadEditableDomains(dir);
  const reconciled = reconcileDrafts(existing, drafts);
  const snapshotId = draftSnapshotId(inputs, existing);
  return {
    snapshotId,
    proposalId: stableHash({ snapshotId, drafts }),
    drafts,
    overrideCandidates: existing.filter(hasDomainLocks).map((definition) => definition.name),
    preview: {
      added: reconciled.added,
      updated: reconciled.updated,
      preserved: reconciled.preserved,
      total: reconciled.merged.length,
    },
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
  return synthesizeDomainDrafts(
    inputs,
    realLlmOrFail(deps),
    deps.draftCache,
    deps.draftModelId,
  );
}

function realLlmOrFail(deps: FlowRouteDeps): LLMClient {
  if (!deps.draftLlm || deps.draftModelId === "stub-llm") {
    throw new Error(
      "draft synthesis requires a real LLM. " +
        "LUDIARS uses the claude CLI (claude -p, no API key) — " +
        "ensure `claude` is on PATH or set ANATOMIA_LLM_BACKEND to a non-stub backend. " +
        "Pass noLlm=true to use the deterministic skeleton seed instead.",
    );
  }
  return deps.draftLlm;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function draftInputsFromContext(ctx: AnalysisContext): DraftInputs {
  return {
    specClauses: ctx.specClauses ?? [],
    filePaths: ctx.files.map((file) => file.path),
    sourceAnchors: ctx.functions.flatMap((fn) => (fn.id ? [String(fn.id)] : [])),
  };
}

/** Snapshot the evidence used for a proposal; presentation order is irrelevant. */
function draftSnapshotId(inputs: DraftInputs, existing: EditableDomainDef[]): string {
  // AnchorId is the normalized Merkle function identity, so semantic body/
  // signature changes invalidate this snapshot while formatting-only edits do not.
  const clauses = inputs.specClauses
    .map((clause) => ({
      id: clause.id,
      sourceFile: clause.sourceFile.replace(/\\/g, "/"),
      heading: clause.heading,
      text: clause.text,
    }))
    .sort((a, b) => {
      const ak = `${a.sourceFile}\0${a.id}`;
      const bk = `${b.sourceFile}\0${b.id}`;
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
  return stableHash({
    clauses,
    filePaths: [...inputs.filePaths].map((path) => path.replace(/\\/g, "/")).sort(),
    sourceAnchors: [...inputs.sourceAnchors].sort(),
    existingDomains: existing
      .map(({ updatedAt: _updatedAt, ...definition }) => definition)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  });
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function optionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${field}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
}

function parseOverrideNames(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("overrideNames must be an array");
  const names = value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`overrideNames[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
  if (new Set(names).size !== names.length) {
    throw new Error("overrideNames must not contain duplicates");
  }
  return names;
}

function hasDomainLocks(definition: EditableDomainDef): boolean {
  return definition.source === "manual" || (definition.lockedFields?.length ?? 0) > 0;
}

function positiveInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("minGroupFunctions must be a positive integer");
  }
  return parsed;
}

function parseDomainDrafts(value: unknown): DomainDraft[] {
  if (!Array.isArray(value)) throw new Error("drafts must be an array");
  const drafts = value.map((item, index) => parseDomainDraft(item, `drafts[${index}]`));
  const names = new Set<string>();
  for (const draft of drafts) {
    if (names.has(draft.name)) throw new Error(`duplicate domain draft name "${draft.name}"`);
    names.add(draft.name);
  }
  return drafts;
}

function parseDomainDraft(value: unknown, field: string): DomainDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const item = value as Record<string, unknown>;
  const pathPatterns = optionalStringArray(item["pathPatterns"], `${field}.pathPatterns`);
  const namePatterns = optionalStringArray(item["namePatterns"], `${field}.namePatterns`);
  for (const pattern of [...pathPatterns, ...namePatterns]) {
    try {
      new RegExp(pattern);
    } catch {
      throw new Error(`${field} contains invalid regex "${pattern}"`);
    }
  }
  return {
    name: requiredString(item["name"], `${field}.name`),
    description: requiredString(item["description"], `${field}.description`),
    pathPatterns,
    namePatterns,
    specRefs: optionalStringArray(item["specRefs"], `${field}.specRefs`),
    mechanics: optionalStringArray(item["mechanics"], `${field}.mechanics`),
    rationale: typeof item["rationale"] === "string" ? item["rationale"].trim() : "",
  };
}

function parseApprovedOrphanProposals(value: unknown): ApprovedOrphanDomainProposal[] {
  if (!Array.isArray(value)) throw new Error("proposals must be an array");
  return value.map((entry, index) => {
    const field = `proposals[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${field} must be an object`);
    }
    const item = entry as Record<string, unknown>;
    const humanSupplement = requiredString(item["humanSupplement"], `${field}.humanSupplement`);
    const specValue = item["spec"];
    if (!specValue || typeof specValue !== "object" || Array.isArray(specValue)) {
      throw new Error(`${field}.spec must be an object`);
    }
    const spec = specValue as Record<string, unknown>;
    const evidenceValue = item["evidence"];
    if (!Array.isArray(evidenceValue)) throw new Error(`${field}.evidence must be an array`);
    const evidence = evidenceValue.map((candidate, evidenceIndex) =>
      parseFunctionLocation(candidate, `${field}.evidence[${evidenceIndex}]`),
    );
    return {
      proposalId: requiredString(item["proposalId"], `${field}.proposalId`),
      snapshotId: requiredString(item["snapshotId"], `${field}.snapshotId`),
      specSnapshotId: requiredString(item["specSnapshotId"], `${field}.specSnapshotId`),
      groupId: requiredString(item["groupId"], `${field}.groupId`),
      origin: "orphan-group" as const,
      domain: parseDomainDraft(item["domain"], `${field}.domain`),
      spec: {
        title: requiredString(spec["title"], `${field}.spec.title`),
        purpose: requiredString(spec["purpose"], `${field}.spec.purpose`),
        responsibilities: optionalStringArray(
          spec["responsibilities"],
          `${field}.spec.responsibilities`,
        ),
        inScope: optionalStringArray(spec["inScope"], `${field}.spec.inScope`),
        outOfScope: optionalStringArray(spec["outOfScope"], `${field}.spec.outOfScope`),
        dependencies: optionalStringArray(spec["dependencies"], `${field}.spec.dependencies`),
        acceptanceCriteria: optionalStringArray(
          spec["acceptanceCriteria"],
          `${field}.spec.acceptanceCriteria`,
        ),
        assumptions: optionalStringArray(spec["assumptions"], `${field}.spec.assumptions`),
        openQuestions: optionalStringArray(spec["openQuestions"], `${field}.spec.openQuestions`),
      },
      evidence,
      humanSupplement,
    };
  });
}

function parseFunctionLocation(value: unknown, field: string): OrphanFunctionLocation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const item = value as Record<string, unknown>;
  const line = positiveLocation(item["line"], `${field}.line`);
  const endLine = positiveLocation(item["endLine"], `${field}.endLine`);
  if (!("enclosingType" in item)) {
    throw new Error(`${field}.enclosingType must be a string or null`);
  }
  const enclosingType =
    item["enclosingType"] === null
      ? null
      : requiredString(item["enclosingType"], `${field}.enclosingType`);
  return {
    anchor: requiredString(item["anchor"], `${field}.anchor`) as OrphanFunctionLocation["anchor"],
    name: requiredString(item["name"], `${field}.name`),
    signature: requiredString(item["signature"], `${field}.signature`),
    signatureShape: requiredString(item["signatureShape"], `${field}.signatureShape`),
    enclosingType,
    file: requiredString(item["file"], `${field}.file`).replace(/\\/g, "/"),
    line,
    endLine,
    reason: "unassigned-domain",
  };
}

function positiveLocation(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/** Restrict ownership to the project's approved ontology, excluding broad builtins. */
async function investigateProjectOrphans(
  context: AnalysisContext,
  ontologyDir: string,
  minGroupFunctions: number,
) {
  const approved = await loadEditableDomains(ontologyDir);
  const names = new Set(approved.map((domain) => domain.name));
  const scoped: AnalysisContext = {
    ...context,
    domains: (context.domains ?? []).filter((domain) => names.has(domain.domain)),
  };
  return investigateOrphanFunctions(scoped, { minGroupFunctions });
}

function flowErrorStatus(error: unknown): 400 | 409 {
  return error instanceof DomainDiscoveryGateError ? 409 : 400;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
