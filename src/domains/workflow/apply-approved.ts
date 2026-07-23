/** Apply Gate-B-approved orphan domains and specs as one rollback-safe unit. */

import { join } from "node:path";
import type { NodeFilter } from "../../types.js";
import {
  loadEditableDomains,
  saveEditableDomain,
  type EditableDomainDef,
} from "../authoring/index.js";
import { domainFileName } from "../authoring/store.js";
import type { ApprovedOrphanDomainProposal } from "./spec-store.js";
import type { OrphanFeatureGroup } from "../discovery/index.js";
import {
  DomainDiscoveryGateError,
  domainDiscoveryGatePath,
  requireGateAApproval,
  saveGateAApproval,
  type DomainDiscoveryGateState,
} from "./gate-state.js";
import {
  approvedDomainSpecRelativePath,
  saveApprovedDomainSpecs,
} from "./spec-store.js";
import { withFileRollback } from "./file-rollback.js";
import { withDomainWorkflowLock } from "./keyed-mutex.js";

export interface ApprovedOrphanApplyResult {
  definitions: EditableDomainDef[];
  writtenDomains: string[];
  writtenSpecs: string[];
}

export interface ApproveOrphanDomainInput {
  repoRoot: string;
  ontologyDir: string;
  proposals: ApprovedOrphanDomainProposal[];
  /** Analysis snapshot explicitly reviewed by the human at Gate B. */
  analysisSnapshotId: string;
  /** Re-read authoritative evidence while holding the project workflow mutex. */
  loadCurrentEvidence(): Promise<CurrentOrphanApprovalEvidence>;
}

export interface CurrentOrphanApprovalEvidence {
  analysisSnapshotId: string;
  specSnapshotId: string;
  candidateGroups: readonly OrphanFeatureGroup[];
}

export interface GateBApprovalPersistence {
  saveApproval: typeof saveGateAApproval;
}

const defaultGateBPersistence: GateBApprovalPersistence = {
  saveApproval: saveGateAApproval,
};

export class OrphanApprovalConflictError extends DomainDiscoveryGateError {
  readonly code = "stale_orphan_proposal";
  readonly dimension: "analysis" | "spec";
  readonly expectedSnapshotId: string;
  readonly actualSnapshotId: string;

  constructor(
    dimension: "analysis" | "spec",
    expectedSnapshotId: string,
    actualSnapshotId: string,
  ) {
    super(
      `stale_orphan_proposal: ${dimension} snapshot changed; expected ${expectedSnapshotId}, current ${actualSnapshotId}`,
    );
    this.name = "OrphanApprovalConflictError";
    this.dimension = dimension;
    this.expectedSnapshotId = expectedSnapshotId;
    this.actualSnapshotId = actualSnapshotId;
  }
}

export interface ApprovedOrphanGateApplyResult extends ApprovedOrphanApplyResult {
  gate: DomainDiscoveryGateState;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function gateBTransactionPaths(
  repoRoot: string,
  ontologyDir: string,
  proposals: readonly ApprovedOrphanDomainProposal[],
): string[] {
  return [
    ...proposals.map((proposal) =>
      join(ontologyDir, domainFileName(proposal.domain.name)),
    ),
    ...proposals.map((proposal) =>
      join(repoRoot, ...approvedDomainSpecRelativePath(proposal.domain.name).split("/")),
    ),
    domainDiscoveryGatePath(repoRoot),
  ];
}

/** Exact file+qualified-signature conjunctions avoid overloads and directory peers. */
export function orphanProposalToEditableDef(
  proposal: ApprovedOrphanDomainProposal,
): EditableDomainDef {
  const membership: NodeFilter[] = proposal.evidence.map((fn) => ({
    pathPattern: `(^|/)${escapeRegex(fn.file.replace(/\\/g, "/"))}$`,
    namePattern: `^${escapeRegex(fn.name)}$`,
    signatureShapePattern: `^${escapeRegex(fn.signatureShape)}$`,
  }));
  return {
    name: proposal.domain.name,
    description: proposal.domain.description,
    membership,
    // Membership is authoritative for orphan promotions. Broad directory marker
    // presets would absorb unrelated assigned/residual functions.
    presetRules: [],
    templateRules: [],
    cardTemplate: `Summarise the "${proposal.domain.name}" domain: ${proposal.domain.description}`,
    source: "manual",
    lockedFields: ["*"],
    mechanics: proposal.domain.mechanics,
    specRefs: [
      ...new Set([
        ...proposal.domain.specRefs,
        approvedDomainSpecRelativePath(proposal.domain.name),
        proposal.spec.title,
      ]),
    ].sort(),
    rationale: proposal.domain.rationale,
  };
}

/**
 * Gate B only creates new domain names. A collision must be resolved by an
 * explicit merge/rename; silently preserving the old def would detach the new
 * spec from the ontology. Newly created files are rolled back on later failure.
 */
export async function applyApprovedOrphanDomains(
  repoRoot: string,
  ontologyDir: string,
  proposals: ApprovedOrphanDomainProposal[],
): Promise<ApprovedOrphanApplyResult> {
  const existing = await loadEditableDomains(ontologyDir);
  const existingNames = new Set(existing.map((def) => def.name));
  const occupiedDomainFiles = new Set(existing.map((def) => domainFileName(def.name)));
  const proposedDomainFiles = new Set<string>();
  for (const proposal of proposals) {
    if (existingNames.has(proposal.domain.name)) {
      throw new Error(
        `domain "${proposal.domain.name}" already exists; merge or rename the proposal explicitly`,
      );
    }
    const fileName = domainFileName(proposal.domain.name);
    if (occupiedDomainFiles.has(fileName) || proposedDomainFiles.has(fileName)) {
      throw new Error(
        `domain "${proposal.domain.name}" collides with ontology file "${fileName}"; rename it explicitly`,
      );
    }
    proposedDomainFiles.add(fileName);
  }

  const definitions = proposals.map(orphanProposalToEditableDef);
  const domainPaths = definitions.map((definition) =>
    join(ontologyDir, domainFileName(definition.name)),
  );
  const specPaths = proposals.map((proposal) =>
    join(repoRoot, ...approvedDomainSpecRelativePath(proposal.domain.name).split("/")),
  );
  return withFileRollback([...domainPaths, ...specPaths], async () => {
    const writtenSpecs = await saveApprovedDomainSpecs(repoRoot, proposals);
    const writtenDomains: string[] = [];
    for (const definition of definitions) {
      writtenDomains.push(await saveEditableDomain(ontologyDir, definition));
    }
    return { definitions, writtenDomains, writtenSpecs };
  });
}

/** Validate Gate B evidence and apply only server-reconstructed source facts. */
export async function approveAndApplyOrphanDomains(
  input: ApproveOrphanDomainInput,
  persistence: GateBApprovalPersistence = defaultGateBPersistence,
): Promise<ApprovedOrphanGateApplyResult> {
  return withDomainWorkflowLock(input.repoRoot, input.ontologyDir, async () => {
    const gate = await requireGateAApproval(input.repoRoot, input.ontologyDir);
    const current = await input.loadCurrentEvidence();
    if (current.analysisSnapshotId !== input.analysisSnapshotId) {
      throw new OrphanApprovalConflictError(
        "analysis",
        input.analysisSnapshotId,
        current.analysisSnapshotId,
      );
    }
    const byId = new Map(current.candidateGroups.map((group) => [group.groupId, group]));
    const domainNames = new Set<string>();
    const groupIds = new Set<string>();
    const trusted: ApprovedOrphanDomainProposal[] = [];

    for (const proposal of input.proposals) {
      if (proposal.snapshotId !== current.analysisSnapshotId) {
        throw new OrphanApprovalConflictError(
          "analysis",
          proposal.snapshotId,
          current.analysisSnapshotId,
        );
      }
      if (proposal.specSnapshotId !== current.specSnapshotId) {
        throw new OrphanApprovalConflictError(
          "spec",
          proposal.specSnapshotId,
          current.specSnapshotId,
        );
      }
      const group = byId.get(proposal.groupId);
      if (!group) throw new Error(`unknown or non-candidate orphan group "${proposal.groupId}"`);
      if (groupIds.has(proposal.groupId)) {
        throw new Error(`duplicate approved orphan group "${proposal.groupId}"`);
      }
      groupIds.add(proposal.groupId);
      const expected = group.functions.map((fn) => String(fn.anchor)).sort();
      const actual = proposal.evidence.map((fn) => String(fn.anchor)).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`proposal ${proposal.proposalId} evidence does not match its orphan group`);
      }
      if (domainNames.has(proposal.domain.name)) {
        throw new Error(`duplicate approved domain name "${proposal.domain.name}"`);
      }
      domainNames.add(proposal.domain.name);
      trusted.push({ ...proposal, evidence: group.functions });
    }

    return withFileRollback(
      gateBTransactionPaths(input.repoRoot, input.ontologyDir, trusted),
      async () => {
        const applied = await applyApprovedOrphanDomains(
          input.repoRoot,
          input.ontologyDir,
          trusted,
        );
        const refreshedGate = await persistence.saveApproval(
          input.repoRoot,
          gate.baselineSnapshotId,
          await loadEditableDomains(input.ontologyDir),
        );
        return { ...applied, gate: refreshedGate };
      },
    );
  });
}
