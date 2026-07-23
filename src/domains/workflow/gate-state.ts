/** Persist and verify Gate A against the exact approved ontology snapshot. */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  loadEditableDomains,
  type EditableDomainDef,
} from "../authoring/index.js";

export interface DomainDiscoveryGateState {
  version: 1;
  baselineSnapshotId: string;
  ontologySnapshotId: string;
}

export class DomainDiscoveryGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainDiscoveryGateError";
  }
}

export function domainDiscoveryGatePath(repoRoot: string): string {
  return join(repoRoot, ".anatomia", "domain-discovery-gate.json");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => key !== "updatedAt")
      .sort()
      .map((key) => [key, canonical(record[key])]),
  );
}

export function editableDomainsSnapshotId(definitions: EditableDomainDef[]): string {
  const ordered = [...definitions].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return createHash("sha256")
    .update(JSON.stringify(canonical(ordered)), "utf8")
    .digest("hex");
}

export async function saveGateAApproval(
  repoRoot: string,
  baselineSnapshotId: string,
  definitions: EditableDomainDef[],
): Promise<DomainDiscoveryGateState> {
  const state: DomainDiscoveryGateState = {
    version: 1,
    baselineSnapshotId,
    ontologySnapshotId: editableDomainsSnapshotId(definitions),
  };
  const path = domainDiscoveryGatePath(repoRoot);
  await mkdir(join(repoRoot, ".anatomia"), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", "utf8");
    await rename(temporary, path);
  } catch (operationError) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AggregateError(
          [operationError, cleanupError],
          "Gate A marker write and temporary-file cleanup both failed",
        );
      }
    }
    throw operationError;
  }
  return state;
}

export async function requireGateAApproval(
  repoRoot: string,
  ontologyDir: string,
): Promise<DomainDiscoveryGateState> {
  let state: DomainDiscoveryGateState;
  try {
    state = JSON.parse(await readFile(domainDiscoveryGatePath(repoRoot), "utf8")) as
      DomainDiscoveryGateState;
  } catch {
    throw new DomainDiscoveryGateError(
      "gate_a_required: approve the spec-derived domain baseline before orphan investigation",
    );
  }
  if (
    state.version !== 1 ||
    typeof state.baselineSnapshotId !== "string" ||
    typeof state.ontologySnapshotId !== "string"
  ) {
    throw new DomainDiscoveryGateError("gate_a_stale: malformed Gate A state; approve again");
  }
  const current = editableDomainsSnapshotId(await loadEditableDomains(ontologyDir));
  if (current !== state.ontologySnapshotId) {
    throw new DomainDiscoveryGateError(
      "gate_a_stale: the approved ontology changed; review the baseline and approve Gate A again",
    );
  }
  return state;
}
