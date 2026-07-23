import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../../../cache/store.js";
import type { SpecClause } from "../../../types.js";
import type {
  OrphanFeatureGroup,
  OrphanFunctionLocation,
  OrphanInvestigation,
} from "../../discovery/index.js";
import {
  assembleOrphanProposalPrompt,
  membershipPatterns,
  synthesizeOrphanDomainProposals,
  type OrphanDomainProposal,
} from "../orphan-proposals.js";

const locations: OrphanFunctionLocation[] = [
  {
    anchor: "a1" as OrphanFunctionLocation["anchor"],
    name: "startCombat",
    signature: "void startCombat()",
    signatureShape: "(sig (scope ) (name startCombat) (ret void))",
    enclosingType: null,
    file: "src/combat/start.ts",
    line: 4,
    endLine: 12,
    reason: "unassigned-domain",
  },
  {
    anchor: "a2" as OrphanFunctionLocation["anchor"],
    name: "resolveHit",
    signature: "Hit resolveHit(Attack attack)",
    signatureShape: "(sig (scope ) (name resolveHit) (ret Hit) (param Attack))",
    enclosingType: null,
    file: "src/combat/hit.ts",
    line: 20,
    endLine: 39,
    reason: "unassigned-domain",
  },
  {
    anchor: "a3" as OrphanFunctionLocation["anchor"],
    name: "finishCombat",
    signature: "void finishCombat()",
    signatureShape: "(sig (scope ) (name finishCombat) (ret void))",
    enclosingType: null,
    file: "src/combat/finish.ts",
    line: 7,
    endLine: 14,
    reason: "unassigned-domain",
  },
];

const group: OrphanFeatureGroup = {
  groupId: "group-combat",
  moduleId: "src/combat",
  kind: "dir",
  label: "combat",
  size: 3,
  functionCount: 3,
  cohesion: 0.75,
  functions: locations,
};

const investigation: OrphanInvestigation = {
  snapshotId: "snapshot-1",
  functions: locations,
  groups: [group],
  candidateGroups: [group],
  remainingFunctions: [],
  minGroupFunctions: 3,
  granularity: "dir",
};

const clauses = [
  {
    id: "SPEC-COMBAT",
    heading: "Combat resolution",
    text: "Resolve attacks and finish an encounter.",
    sourceFile: "spec/feature/combat.md",
  } as SpecClause,
];

describe("orphan domain proposals", () => {
  it("derives membership only from deterministic source evidence", () => {
    expect(membershipPatterns(group)).toEqual(["(^|/)src/combat/"]);
    expect(assembleOrphanProposalPrompt(group, clauses)).toContain("src/combat/start.ts:4");
  });

  it("uses the LLM for meaning while preserving evidence and known spec refs", async () => {
    const llm = vi.fn(async () =>
      JSON.stringify({
        name: "combat",
        description: "Owns encounter resolution.",
        rationale: "The functions form one encounter lifecycle.",
        responsibilities: ["start and resolve encounters"],
        inScope: ["hit resolution"],
        outOfScope: ["rendering"],
        dependencies: ["actor state"],
        acceptanceCriteria: ["an encounter reaches a terminal result"],
        assumptions: ["one active encounter"],
        openQuestions: ["multi-party encounters"],
        specRefs: ["SPEC-COMBAT", "HALLUCINATED"],
        mechanics: ["combat"],
      }),
    );

    const proposals = await synthesizeOrphanDomainProposals(
      investigation,
      clauses,
      llm,
    );

    expect(llm).toHaveBeenCalledTimes(1);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.domain.pathPatterns).toEqual(["(^|/)src/combat/"]);
    expect(proposals[0]!.domain.specRefs).toEqual(["SPEC-COMBAT"]);
    expect(proposals[0]!.evidence).toEqual(locations);
    expect(proposals[0]!.proposalId).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a small or unknown group before calling the LLM", async () => {
    const llm = vi.fn(async () => "{}");
    await expect(
      synthesizeOrphanDomainProposals(investigation, clauses, llm, {
        groupIds: ["not-a-candidate"],
      }),
    ).rejects.toThrow(/unknown or non-candidate/);
    expect(llm).not.toHaveBeenCalled();
  });

  it("invalidates cached proposals when the authoritative spec path changes", async () => {
    const llm = vi.fn(async () =>
      JSON.stringify({ name: "combat", description: "Owns encounter resolution." }),
    );
    const cache = createMemoryStore<OrphanDomainProposal>();
    const first = await synthesizeOrphanDomainProposals(investigation, clauses, llm, { cache });
    const movedClauses = clauses.map((clause) => ({
      ...clause,
      sourceFile: "spec/feature/encounter.md",
    }));
    const second = await synthesizeOrphanDomainProposals(
      investigation,
      movedClauses,
      llm,
      { cache },
    );

    expect(llm).toHaveBeenCalledTimes(2);
    expect(second[0]!.specSnapshotId).not.toBe(first[0]!.specSnapshotId);
  });

  it("fails fast on malformed semantic output", async () => {
    await expect(
      synthesizeOrphanDomainProposals(investigation, clauses, async () => "not json"),
    ).rejects.toThrow(/no JSON object/);
  });
});
