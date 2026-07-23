/** Reconcile and persist one explicitly approved Gate A baseline. */

import { join } from "node:path";
import {
  draftToEditableDef,
  domainFileName,
  editableDomainDocumentPaths,
  loadEditableDomains,
  saveEditableDomains,
} from "../authoring/store.js";
import { reconcileDrafts } from "../authoring/reconcile.js";
import type {
  DomainDraft,
  EditableDomainDef,
  ReconcileResult,
} from "../authoring/types.js";
import { LOCKABLE_FIELDS } from "../authoring/types.js";
import {
  DomainDiscoveryGateError,
  domainDiscoveryGatePath,
  saveGateAApproval,
  type DomainDiscoveryGateState,
} from "./gate-state.js";
import { withFileRollback } from "./file-rollback.js";
import { withDomainWorkflowLock } from "./keyed-mutex.js";

export interface ApplyGateAApprovalInput {
  repoRoot: string;
  ontologyDir: string;
  expectedSnapshotId: string;
  drafts: DomainDraft[];
  /** Existing locked domains that the human explicitly chose to adjust again. */
  overrideNames?: readonly string[];
  /** Recompute the current spec/code/domain evidence snapshot while holding the mutex. */
  computeSnapshot(existingDefinitions: EditableDomainDef[]): Promise<string>;
}

export interface GateAReconcileSummary {
  added: string[];
  updated: string[];
  accepted: string[];
  preserved: string[];
  overridden: string[];
  total: number;
}

export interface ApplyGateAApprovalResult {
  snapshotId: string;
  definitions: EditableDomainDef[];
  reconcile: ReconcileResult;
  applied: GateAReconcileSummary;
  gate: DomainDiscoveryGateState;
  writtenDomainPaths: string[];
}

/** Injectable persistence boundary used by failure-path tests. */
export interface GateAApprovalPersistence {
  loadDefinitions(dir: string): Promise<EditableDomainDef[]>;
  listDefinitionPaths?(dir: string): Promise<string[]>;
  saveDefinitions(dir: string, definitions: EditableDomainDef[]): Promise<string[]>;
  saveApproval(
    repoRoot: string,
    baselineSnapshotId: string,
    definitions: EditableDomainDef[],
  ): Promise<DomainDiscoveryGateState>;
}

const defaultPersistence: GateAApprovalPersistence = {
  loadDefinitions: loadEditableDomains,
  listDefinitionPaths: editableDomainDocumentPaths,
  saveDefinitions: saveEditableDomains,
  saveApproval: saveGateAApproval,
};

export class GateAApprovalConflictError extends DomainDiscoveryGateError {
  readonly code = "stale_domain_proposal";
  readonly expectedSnapshotId: string;
  readonly actualSnapshotId: string;

  constructor(expectedSnapshotId: string, actualSnapshotId: string) {
    super(
      "stale_domain_proposal: the spec, code, or domains changed after proposal generation; " +
        "create a fresh proposal",
    );
    this.name = "GateAApprovalConflictError";
    this.expectedSnapshotId = expectedSnapshotId;
    this.actualSnapshotId = actualSnapshotId;
  }
}

export class GateAOverrideRequiredError extends DomainDiscoveryGateError {
  readonly code = "explicit_domain_override_required";
  readonly domains: string[];

  constructor(domains: string[]) {
    super(
      `explicit_domain_override_required: ${domains.join(", ")}`,
    );
    this.name = "GateAOverrideRequiredError";
    this.domains = [...domains];
  }
}

function requireNonEmpty(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} is required`);
}

function reconcileWithExplicitOverrides(
  existing: EditableDomainDef[],
  drafts: DomainDraft[],
  overrideNames: readonly string[],
): ReconcileResult {
  const existingByName = new Map<string, EditableDomainDef>();
  for (const definition of existing) {
    if (existingByName.has(definition.name)) {
      throw new Error(`duplicate existing domain "${definition.name}"`);
    }
    existingByName.set(definition.name, definition);
  }
  const draftNames = new Set<string>();
  for (const draft of drafts) {
    requireNonEmpty(draft.name, "draft.name");
    if (draftNames.has(draft.name)) throw new Error(`duplicate domain draft "${draft.name}"`);
    draftNames.add(draft.name);
  }

  const overrides = new Set<string>();
  for (const name of overrideNames) {
    requireNonEmpty(name, "overrideNames entry");
    if (!existingByName.has(name) || !draftNames.has(name)) {
      throw new Error(
        `override domain "${name}" must identify an existing domain with a submitted draft`,
      );
    }
    overrides.add(name);
  }

  const missingOverrides = drafts
    .filter((draft) => {
      const prior = existingByName.get(draft.name);
      return (
        prior !== undefined &&
        hasDomainLocks(prior) &&
        domainDraftDiffers(prior, draft) &&
        !overrides.has(draft.name)
      );
    })
    .map((draft) => draft.name);
  if (missingOverrides.length > 0) {
    throw new GateAOverrideRequiredError(missingOverrides);
  }

  // Only explicitly named domains are unlocked for this reconciliation. The
  // persisted result is locked again below as part of human Gate A approval.
  const reconcileInput = existing.map((definition) =>
    overrides.has(definition.name)
      ? { ...definition, source: "reconstructed" as const, lockedFields: [] }
      : definition,
  );
  const raw = reconcileDrafts(reconcileInput, drafts);
  const mergedByName = new Map(raw.merged.map((definition) => [definition.name, definition]));
  const added: string[] = [];
  const updated: string[] = [];
  const preserved: string[] = [];
  for (const draft of drafts) {
    const prior = existingByName.get(draft.name);
    if (!prior) {
      added.push(draft.name);
      continue;
    }
    const merged = mergedByName.get(draft.name);
    if (!merged) throw new Error(`reconcile omitted domain "${draft.name}"`);
    if (domainContentDiffers(prior, merged)) updated.push(draft.name);
    else preserved.push(draft.name);
  }
  return { merged: raw.merged, added, updated, preserved };
}

function hasDomainLocks(definition: EditableDomainDef): boolean {
  return definition.source === "manual" || (definition.lockedFields?.length ?? 0) > 0;
}

const DRAFT_CONTENT_FIELDS = [
  ...LOCKABLE_FIELDS,
  "mechanics",
  "specRefs",
  "rationale",
] as const;

function domainContentDiffers(
  before: EditableDomainDef,
  after: EditableDomainDef,
): boolean {
  return DRAFT_CONTENT_FIELDS.some(
    (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
  );
}

function domainDraftDiffers(
  definition: EditableDomainDef,
  draft: DomainDraft,
): boolean {
  return domainContentDiffers(definition, draftToEditableDef(draft));
}

function acceptDefinitions(definitions: EditableDomainDef[]): EditableDomainDef[] {
  return definitions.map((definition) => ({
    ...definition,
    source: "manual" as const,
    lockedFields: ["*" as const],
  }));
}

async function transactionPaths(
  repoRoot: string,
  ontologyDir: string,
  definitions: readonly EditableDomainDef[],
  persistence: GateAApprovalPersistence,
): Promise<string[]> {
  const gatePath = domainDiscoveryGatePath(repoRoot);
  return [
    ...((await persistence.listDefinitionPaths?.(ontologyDir)) ?? []),
    ...definitions.map((definition) => join(ontologyDir, domainFileName(definition.name))),
    gatePath,
  ];
}

function summarize(
  result: ReconcileResult,
  overrideNames: ReadonlySet<string>,
): GateAReconcileSummary {
  const overridden = result.updated.filter((name) => overrideNames.has(name));
  return {
    added: [...result.added],
    updated: [...result.updated],
    accepted: [
      ...result.added,
      ...result.updated.filter((name) => !overrideNames.has(name)),
    ],
    preserved: [...result.preserved],
    overridden,
    total: result.merged.length,
  };
}

/**
 * Compare-and-apply the accepted Gate A domains. Snapshot validation, reconcile,
 * domain writes, and approval-marker write all run under the same process mutex.
 */
export async function applyGateAApproval(
  input: ApplyGateAApprovalInput,
  persistence: GateAApprovalPersistence = defaultPersistence,
): Promise<ApplyGateAApprovalResult> {
  requireNonEmpty(input.repoRoot, "repoRoot");
  requireNonEmpty(input.ontologyDir, "ontologyDir");
  requireNonEmpty(input.expectedSnapshotId, "expectedSnapshotId");

  return withDomainWorkflowLock(input.repoRoot, input.ontologyDir, async () => {
    const existing = await persistence.loadDefinitions(input.ontologyDir);
    const actualSnapshotId = await input.computeSnapshot(existing);
    requireNonEmpty(actualSnapshotId, "computed snapshotId");
    if (actualSnapshotId !== input.expectedSnapshotId) {
      throw new GateAApprovalConflictError(input.expectedSnapshotId, actualSnapshotId);
    }

    const rawReconcile = reconcileWithExplicitOverrides(
      existing,
      input.drafts,
      input.overrideNames ?? [],
    );
    const definitions = acceptDefinitions(rawReconcile.merged);
    const reconcile: ReconcileResult = { ...rawReconcile, merged: definitions };

    return withFileRollback(
      await transactionPaths(
        input.repoRoot,
        input.ontologyDir,
        definitions,
        persistence,
      ),
      async () => {
        const writtenDomainPaths = await persistence.saveDefinitions(
          input.ontologyDir,
          definitions,
        );
        const gate = await persistence.saveApproval(
          input.repoRoot,
          actualSnapshotId,
          definitions,
        );
        return {
          snapshotId: actualSnapshotId,
          definitions,
          reconcile,
          applied: summarize(reconcile, new Set(input.overrideNames ?? [])),
          gate,
          writtenDomainPaths,
        };
      },
    );
  });
}
