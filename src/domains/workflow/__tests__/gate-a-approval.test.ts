import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  domainFileName,
  editableDomainDocumentPaths,
  loadEditableDomains,
  saveEditableDomain,
  saveEditableDomains,
} from "../../authoring/store.js";
import type { DomainDraft, EditableDomainDef } from "../../authoring/types.js";
import {
  GateAApprovalConflictError,
  applyGateAApproval,
  type GateAApprovalPersistence,
} from "../gate-a-approval.js";
import {
  domainDiscoveryGatePath,
  editableDomainsSnapshotId,
  requireGateAApproval,
  saveGateAApproval,
} from "../gate-state.js";

const roots: string[] = [];

function draft(name: string, description: string): DomainDraft {
  return {
    name,
    description,
    pathPatterns: [`(^|/)src/${name}/`],
    namePatterns: [],
    specRefs: [`spec:${name}`],
    mechanics: [],
    rationale: `The ${name} files are cohesive.`,
  };
}

function definition(name: string, description: string): EditableDomainDef {
  return {
    name,
    description,
    presetRules: [],
    templateRules: [],
    source: "manual",
    lockedFields: ["*"],
  };
}

async function createRoot(): Promise<{ repoRoot: string; ontologyDir: string }> {
  const repoRoot = await mkdtemp(join(tmpdir(), "anatomia-gate-a-"));
  roots.push(repoRoot);
  return { repoRoot, ontologyDir: join(repoRoot, "ontology") };
}

async function currentSnapshot(ontologyDir: string): Promise<string> {
  return editableDomainsSnapshotId(await loadEditableDomains(ontologyDir));
}

const computeSnapshot = async (definitions: EditableDomainDef[]): Promise<string> =>
  editableDomainsSnapshotId(definitions);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Gate A approval workflow", () => {
  it("requires an explicit per-domain override, then re-locks the adjustment", async () => {
    const { repoRoot, ontologyDir } = await createRoot();
    await saveEditableDomain(ontologyDir, definition("combat", "Human description"));
    const expectedSnapshotId = await currentSnapshot(ontologyDir);

    await expect(
      applyGateAApproval({
        repoRoot,
        ontologyDir,
        expectedSnapshotId,
        drafts: [draft("combat", "Automated description")],
        overrideNames: [],
        computeSnapshot,
      }),
    ).rejects.toMatchObject({
      code: "explicit_domain_override_required",
      domains: ["combat"],
    });
    await expect(loadEditableDomains(ontologyDir)).resolves.toMatchObject([
      { description: "Human description", source: "manual", lockedFields: ["*"] },
    ]);

    const overridden = await applyGateAApproval({
      repoRoot,
      ontologyDir,
      expectedSnapshotId: await currentSnapshot(ontologyDir),
      drafts: [draft("combat", "Human readjustment")],
      overrideNames: ["combat"],
      computeSnapshot,
    });
    expect(overridden.reconcile.updated).toEqual(["combat"]);
    expect(overridden.applied).toEqual({
      added: [],
      updated: ["combat"],
      accepted: [],
      preserved: [],
      overridden: ["combat"],
      total: 1,
    });
    expect(overridden.definitions[0]).toMatchObject({
      description: "Human readjustment",
      source: "manual",
      lockedFields: ["*"],
    });
    expect(overridden.gate.baselineSnapshotId).toBe(overridden.snapshotId);
  });

  it("serializes the same project/ontology scope so a competing stale apply loses CAS", async () => {
    const { repoRoot, ontologyDir } = await createRoot();
    const expectedSnapshotId = editableDomainsSnapshotId([]);

    const [first, second] = await Promise.allSettled([
      applyGateAApproval({
        repoRoot,
        ontologyDir,
        expectedSnapshotId,
        drafts: [draft("combat", "Combat")],
        computeSnapshot,
      }),
      applyGateAApproval({
        repoRoot,
        ontologyDir,
        expectedSnapshotId,
        drafts: [draft("movement", "Movement")],
        computeSnapshot,
      }),
    ]);

    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") {
      expect(second.reason).toBeInstanceOf(GateAApprovalConflictError);
      expect(second.reason).toMatchObject({
        code: "stale_domain_proposal",
        expectedSnapshotId,
      });
    }
    const persisted = await loadEditableDomains(ontologyDir);
    expect(persisted.map((item) => item.name)).toEqual(["combat"]);
  });

  it("restores every domain file and the gate marker when approval persistence fails", async () => {
    const { repoRoot, ontologyDir } = await createRoot();
    await saveEditableDomains(ontologyDir, [
      definition("combat", "Old combat"),
      definition("movement", "Old movement"),
    ]);
    const initial = await loadEditableDomains(ontologyDir);
    await saveGateAApproval(repoRoot, "old-baseline", initial);

    const combatPath = join(ontologyDir, domainFileName("combat"));
    const movementPath = join(ontologyDir, domainFileName("movement"));
    const gatePath = domainDiscoveryGatePath(repoRoot);
    const before = await Promise.all([
      readFile(combatPath),
      readFile(movementPath),
      readFile(gatePath),
    ]);
    const persistence: GateAApprovalPersistence = {
      loadDefinitions: loadEditableDomains,
      saveDefinitions: saveEditableDomains,
      saveApproval: async () => {
        await writeFile(gatePath, "partially-written-marker", "utf8");
        throw new Error("injected Gate A marker failure");
      },
    };

    await expect(
      applyGateAApproval(
        {
          repoRoot,
          ontologyDir,
          expectedSnapshotId: editableDomainsSnapshotId(initial),
          drafts: [
            draft("combat", "New combat"),
            draft("movement", "New movement"),
          ],
          overrideNames: ["combat", "movement"],
          computeSnapshot,
        },
        persistence,
      ),
    ).rejects.toThrow("injected Gate A marker failure");

    const after = await Promise.all([
      readFile(combatPath),
      readFile(movementPath),
      readFile(gatePath),
    ]);
    expect(after).toEqual(before);
  });

  it("removes newly created partial files when domain persistence fails", async () => {
    const { repoRoot, ontologyDir } = await createRoot();
    const persistence: GateAApprovalPersistence = {
      loadDefinitions: loadEditableDomains,
      saveDefinitions: async (dir, definitions) => {
        await saveEditableDomain(dir, definitions[0]!);
        throw new Error("injected second-domain failure");
      },
      saveApproval: saveGateAApproval,
    };

    await expect(
      applyGateAApproval(
        {
          repoRoot,
          ontologyDir,
          expectedSnapshotId: editableDomainsSnapshotId([]),
          drafts: [draft("combat", "Combat"), draft("movement", "Movement")],
          computeSnapshot,
        },
        persistence,
      ),
    ).rejects.toThrow("injected second-domain failure");

    await expect(loadEditableDomains(ontologyDir)).resolves.toEqual([]);
    await expect(readFile(domainDiscoveryGatePath(repoRoot), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("updates a retune-style ontology document in place without duplicating the domain", async () => {
    const { repoRoot, ontologyDir } = await createRoot();
    await mkdir(ontologyDir, { recursive: true });
    const legacyPath = join(ontologyDir, "combat.domain.json");
    await writeFile(
      legacyPath,
      JSON.stringify(definition("combat", "Retune description"), null, 2) + "\n",
      "utf8",
    );

    const result = await applyGateAApproval({
      repoRoot,
      ontologyDir,
      expectedSnapshotId: await currentSnapshot(ontologyDir),
      drafts: [draft("combat", "Human adjustment")],
      overrideNames: ["combat"],
      computeSnapshot,
    });

    expect(result.writtenDomainPaths).toEqual([legacyPath]);
    await expect(loadEditableDomains(ontologyDir)).resolves.toMatchObject([
      { name: "combat", description: "Human adjustment", lockedFields: ["*"] },
    ]);
    await expect(requireGateAApproval(repoRoot, ontologyDir)).resolves.toMatchObject({
      baselineSnapshotId: result.snapshotId,
    });
    await expect(access(join(ontologyDir, domainFileName("combat")))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("restores a retune-style source document when Gate A marker persistence fails", async () => {
    const { repoRoot, ontologyDir } = await createRoot();
    await mkdir(ontologyDir, { recursive: true });
    const legacyPath = join(ontologyDir, "combat.domain.json");
    await writeFile(
      legacyPath,
      JSON.stringify(definition("combat", "Retune description"), null, 2) + "\n",
      "utf8",
    );
    const before = await readFile(legacyPath);

    await expect(
      applyGateAApproval(
        {
          repoRoot,
          ontologyDir,
          expectedSnapshotId: await currentSnapshot(ontologyDir),
          drafts: [draft("combat", "Must roll back")],
          overrideNames: ["combat"],
          computeSnapshot,
        },
        {
          loadDefinitions: loadEditableDomains,
          listDefinitionPaths: editableDomainDocumentPaths,
          saveDefinitions: saveEditableDomains,
          saveApproval: async () => {
            throw new Error("injected marker failure");
          },
        },
      ),
    ).rejects.toThrow(/injected marker failure/);

    await expect(readFile(legacyPath)).resolves.toEqual(before);
  });
});
