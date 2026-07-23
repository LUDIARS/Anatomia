import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OrphanFunctionLocation } from "../../discovery/index.js";
import type { ApprovedOrphanDomainProposal } from "../spec-store.js";
import {
  approvedDomainSpecRelativePath,
  renderApprovedDomainSpec,
  saveApprovedDomainSpecs,
} from "../spec-store.js";

const roots: string[] = [];

function approved(): ApprovedOrphanDomainProposal {
  const evidence: OrphanFunctionLocation[] = [
    {
      anchor: "a1" as OrphanFunctionLocation["anchor"],
      name: "resolveHit",
      signature: "Hit resolveHit()",
      signatureShape: "(sig (scope ) (name resolveHit) (ret Hit))",
      enclosingType: null,
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
      name: "combat",
      description: "Encounter resolution",
      pathPatterns: ["(^|/)src/combat/"],
      namePatterns: [],
      specRefs: [],
      mechanics: ["combat"],
      rationale: "cohesive lifecycle",
    },
    spec: {
      title: "combat",
      purpose: "Resolve an encounter.",
      responsibilities: ["resolve attacks"],
      inScope: ["damage"],
      outOfScope: ["rendering"],
      dependencies: ["actor state"],
      acceptanceCriteria: ["terminal result is produced"],
      assumptions: [],
      openQuestions: [],
    },
    evidence,
    humanSupplement: "Boss encounters share the same resolution rules.",
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("approved orphan-domain specs", () => {
  it("renders file:line evidence, supplement, and provenance", () => {
    const rendered = renderApprovedDomainSpec(approved());
    expect(rendered).toContain("src/combat/hit.ts:20");
    expect(rendered).toContain("Boss encounters share");
    expect(rendered).toContain("proposal-1");
  });

  it("rejects Gate B output without a human supplement", () => {
    const proposal = approved();
    proposal.humanSupplement = "   ";
    expect(() => renderApprovedDomainSpec(proposal)).toThrow(/humanSupplement is required/);
  });

  it("creates a new spec and treats byte-identical reapply as idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-domain-spec-"));
    roots.push(root);
    const proposal = approved();
    const paths = await saveApprovedDomainSpecs(root, [proposal]);
    expect(paths).toEqual(["spec/feature/domain-combat.md"]);
    expect(await saveApprovedDomainSpecs(root, [proposal])).toEqual([]);
    expect(await readFile(join(root, ...paths[0]!.split("/")), "utf8")).toContain(
      "resolveHit",
    );
  });

  it("refuses to overwrite a different existing feature spec", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-domain-spec-"));
    roots.push(root);
    const proposal = approved();
    const relative = approvedDomainSpecRelativePath(proposal.domain.name);
    const path = join(root, ...relative.split("/"));
    await mkdir(join(root, "spec", "feature"), { recursive: true });
    await writeFile(path, "human-owned spec\n", "utf8");
    await expect(saveApprovedDomainSpecs(root, [proposal])).rejects.toThrow(
      /refusing to overwrite/,
    );
  });

  it("rejects slug collisions before writing either spec", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-domain-spec-"));
    roots.push(root);
    const first = approved();
    first.domain.name = "foo bar";
    const second = approved();
    second.domain.name = "foo-bar";
    second.proposalId = "proposal-2";
    await expect(saveApprovedDomainSpecs(root, [first, second])).rejects.toThrow(
      /multiple approved domains resolve/,
    );
    await expect(accessSpecDir(root)).resolves.toBe(false);
  });
});

async function accessSpecDir(root: string): Promise<boolean> {
  try {
    await readFile(join(root, "spec", "feature", "domain-foo-bar.md"), "utf8");
    return true;
  } catch {
    return false;
  }
}
