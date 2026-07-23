import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEditableDomains, saveEditableDomain } from "../../authoring/index.js";
import { domainFileName } from "../../authoring/store.js";
import type { OrphanFeatureGroup, OrphanFunctionLocation } from "../../discovery/index.js";
import type { ApprovedOrphanDomainProposal } from "../spec-store.js";
import {
  applyApprovedOrphanDomains,
  approveAndApplyOrphanDomains,
  orphanProposalToEditableDef,
} from "../apply-approved.js";
import { domainDiscoveryGatePath, saveGateAApproval } from "../gate-state.js";

const roots: string[] = [];

function proposal(name = "combat"): ApprovedOrphanDomainProposal {
  const evidence: OrphanFunctionLocation[] = [
    {
      anchor: "a1" as OrphanFunctionLocation["anchor"],
      name: "resolveHit",
      signature: "Hit resolveHit()",
      signatureShape: "(sig (scope CombatResolver) (name resolveHit) (ret Hit))",
      enclosingType: "CombatResolver",
      file: "src/combat/hit.ts",
      line: 20,
      endLine: 39,
      reason: "unassigned-domain",
    },
  ];
  return {
    proposalId: "proposal-1",
    snapshotId: "snapshot-1",
    specSnapshotId: "spec-snapshot-1",
    groupId: "group-1",
    origin: "orphan-group",
    domain: {
      name,
      description: "Encounter resolution",
      pathPatterns: ["(^|/)src/combat/"],
      namePatterns: [],
      specRefs: [],
      mechanics: [],
      rationale: "cohesive lifecycle",
    },
    spec: {
      title: name,
      purpose: "Resolve an encounter.",
      responsibilities: ["resolve attacks"],
      inScope: [],
      outOfScope: [],
      dependencies: [],
      acceptanceCriteria: [],
      assumptions: [],
      openQuestions: [],
    },
    evidence,
    humanSupplement: "Reviewed by the domain owner.",
  };
}

function groupFor(proposal: ApprovedOrphanDomainProposal): OrphanFeatureGroup {
  return {
    groupId: proposal.groupId,
    moduleId: `src/${proposal.domain.name}`,
    kind: "dir",
    label: proposal.domain.name,
    size: proposal.evidence.length,
    functionCount: proposal.evidence.length,
    cohesion: 1,
    functions: proposal.evidence,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("approved orphan domain apply", () => {
  it("persists exact file+symbol membership instead of the directory proposal", () => {
    const definition = orphanProposalToEditableDef(proposal());
    expect(definition.presetRules).toEqual([]);
    expect(definition.membership).toEqual([
      {
        pathPattern: "(^|/)src/combat/hit\\.ts$",
        namePattern: "^resolveHit$",
        signatureShapePattern:
          "^\\(sig \\(scope CombatResolver\\) \\(name resolveHit\\) \\(ret Hit\\)\\)$",
      },
    ]);
    expect(definition.membership?.[0]).not.toHaveProperty("anchorPattern");
  });

  it("rejects a domain-name collision before writing its spec", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-approved-"));
    roots.push(root);
    const ontologyDir = join(root, "ontology");
    const existing = orphanProposalToEditableDef(proposal());
    await saveEditableDomain(ontologyDir, existing);

    await expect(
      applyApprovedOrphanDomains(root, ontologyDir, [proposal()]),
    ).rejects.toThrow(/already exists/);
    await expect(access(join(root, "spec", "feature", "domain-combat.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rolls back a newly written spec when ontology persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-approved-"));
    roots.push(root);
    const blockedOntologyPath = join(root, "not-a-directory");
    await writeFile(blockedOntologyPath, "blocked", "utf8");

    await expect(
      applyApprovedOrphanDomains(root, blockedOntologyPath, [proposal()]),
    ).rejects.toThrow();
    await expect(access(join(root, "spec", "feature", "domain-combat.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects stale spec evidence and rewrites client locations from the server group", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-approved-"));
    roots.push(root);
    const approved = proposal();
    const trustedLocation = approved.evidence[0]!;
    const group: OrphanFeatureGroup = {
      groupId: approved.groupId,
      moduleId: "src/combat",
      kind: "dir",
      label: "combat",
      size: 1,
      functionCount: 1,
      cohesion: 1,
      functions: [trustedLocation],
    };
    await saveGateAApproval(root, "baseline", []);

    await expect(
      approveAndApplyOrphanDomains({
        repoRoot: root,
        ontologyDir: join(root, "ontology"),
        proposals: [approved],
        analysisSnapshotId: approved.snapshotId,
        loadCurrentEvidence: async () => ({
          analysisSnapshotId: approved.snapshotId,
          specSnapshotId: "changed-spec",
          candidateGroups: [group],
        }),
      }),
    ).rejects.toThrow(/spec snapshot changed/);

    const tampered = {
      ...approved,
      evidence: [{ ...trustedLocation, file: "fake.ts", line: 999 }],
    };
    await approveAndApplyOrphanDomains({
      repoRoot: root,
      ontologyDir: join(root, "ontology"),
      proposals: [tampered],
      analysisSnapshotId: approved.snapshotId,
      loadCurrentEvidence: async () => ({
        analysisSnapshotId: approved.snapshotId,
        specSnapshotId: approved.specSnapshotId,
        candidateGroups: [group],
      }),
    });
    const spec = await readFile(join(root, "spec", "feature", "domain-combat.md"), "utf8");
    expect(spec).toContain("src/combat/hit.ts:20");
    expect(spec).not.toContain("fake.ts:999");
  });

  it("serializes competing Gate B applies so a stale request cannot delete the winner", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-approved-"));
    roots.push(root);
    const ontologyDir = join(root, "ontology");
    await saveGateAApproval(root, "baseline", []);
    const first = proposal("combat");
    const second = proposal("movement");
    second.proposalId = "proposal-2";
    second.groupId = "group-2";
    second.evidence = [
      {
        ...second.evidence[0]!,
        anchor: "a2" as OrphanFunctionLocation["anchor"],
        file: "src/movement/move.ts",
      },
    ];
    const groups = [groupFor(first), groupFor(second)];

    const results = await Promise.allSettled(
      [first, second].map((approved) =>
        approveAndApplyOrphanDomains({
          repoRoot: root,
          ontologyDir,
          proposals: [approved],
          analysisSnapshotId: approved.snapshotId,
          loadCurrentEvidence: async () => {
            const currentDefinitions = await loadEditableDomains(ontologyDir);
            return {
              analysisSnapshotId:
                currentDefinitions.length === 0 ? approved.snapshotId : "changed-after-winner",
              specSnapshotId: approved.specSnapshotId,
              candidateGroups: groups,
            };
          },
        }),
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = results.find((result) => result.status === "fulfilled");
    if (!winner || winner.status !== "fulfilled") throw new Error("missing Gate B winner");
    await expect(access(winner.value.writtenDomains[0]!)).resolves.toBeUndefined();
    await expect(access(join(root, ...winner.value.writtenSpecs[0]!.split("/")))).resolves.toBeUndefined();
  });

  it("rolls back domain, spec, and marker when the atomic Gate B marker refresh fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-approved-"));
    roots.push(root);
    const ontologyDir = join(root, "ontology");
    const approved = proposal();
    const group = groupFor(approved);
    await saveGateAApproval(root, "baseline", []);
    const markerPath = domainDiscoveryGatePath(root);
    const markerBefore = await readFile(markerPath, "utf8");

    await expect(
      approveAndApplyOrphanDomains(
        {
          repoRoot: root,
          ontologyDir,
          proposals: [approved],
          analysisSnapshotId: approved.snapshotId,
          loadCurrentEvidence: async () => ({
            analysisSnapshotId: approved.snapshotId,
            specSnapshotId: approved.specSnapshotId,
            candidateGroups: [group],
          }),
        },
        {
          saveApproval: async () => {
            await writeFile(markerPath, "partial marker", "utf8");
            throw new Error("injected Gate B marker failure");
          },
        },
      ),
    ).rejects.toThrow(/injected Gate B marker failure/);

    await expect(readFile(markerPath, "utf8")).resolves.toBe(markerBefore);
    await expect(access(join(root, "spec", "feature", "domain-combat.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(join(ontologyDir, domainFileName("combat")))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rechecks the current analysis snapshot inside the workflow lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-approved-"));
    roots.push(root);
    const ontologyDir = join(root, "ontology");
    const approved = proposal();
    await saveGateAApproval(root, "baseline", []);

    await expect(
      approveAndApplyOrphanDomains({
        repoRoot: root,
        ontologyDir,
        proposals: [approved],
        analysisSnapshotId: approved.snapshotId,
        loadCurrentEvidence: async () => ({
          analysisSnapshotId: "newer-analysis",
          specSnapshotId: approved.specSnapshotId,
          candidateGroups: [groupFor(approved)],
        }),
      }),
    ).rejects.toThrow(/stale_orphan_proposal/);
    await expect(access(join(root, "spec", "feature", "domain-combat.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects approving the same orphan group as two domain names", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-approved-"));
    roots.push(root);
    const ontologyDir = join(root, "ontology");
    const first = proposal("combat");
    const duplicate = proposal("encounter");
    duplicate.proposalId = "proposal-duplicate";
    await saveGateAApproval(root, "baseline", []);

    await expect(
      approveAndApplyOrphanDomains({
        repoRoot: root,
        ontologyDir,
        proposals: [first, duplicate],
        analysisSnapshotId: first.snapshotId,
        loadCurrentEvidence: async () => ({
          analysisSnapshotId: first.snapshotId,
          specSnapshotId: first.specSnapshotId,
          candidateGroups: [groupFor(first)],
        }),
      }),
    ).rejects.toThrow(/duplicate approved orphan group/);
  });
});
