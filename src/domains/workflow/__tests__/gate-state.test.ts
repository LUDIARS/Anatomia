import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEditableDomains, saveEditableDomain } from "../../authoring/index.js";
import type { EditableDomainDef } from "../../authoring/types.js";
import {
  DomainDiscoveryGateError,
  requireGateAApproval,
  saveGateAApproval,
} from "../gate-state.js";

const roots: string[] = [];

function definition(description = "Combat"): EditableDomainDef {
  return {
    name: "combat",
    description,
    presetRules: [],
    templateRules: [],
    source: "manual",
    lockedFields: ["*"],
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Gate A state", () => {
  it("requires an explicit approval marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-gate-"));
    roots.push(root);
    await expect(requireGateAApproval(root, join(root, "ontology"))).rejects.toBeInstanceOf(
      DomainDiscoveryGateError,
    );
  });

  it("accepts the exact approved ontology and rejects later edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-gate-"));
    roots.push(root);
    const dir = join(root, "ontology");
    await saveEditableDomain(dir, definition());
    const approved = await loadEditableDomains(dir);
    await saveGateAApproval(root, "baseline-1", approved);

    await expect(requireGateAApproval(root, dir)).resolves.toMatchObject({
      baselineSnapshotId: "baseline-1",
    });

    await saveEditableDomain(dir, definition("Changed after approval"));
    await expect(requireGateAApproval(root, dir)).rejects.toThrow(/gate_a_stale/);

    const changed = await loadEditableDomains(dir);
    await saveGateAApproval(root, "baseline-2", changed);
    await expect(requireGateAApproval(root, dir)).resolves.toMatchObject({
      baselineSnapshotId: "baseline-2",
    });
  });
});
