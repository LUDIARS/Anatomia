import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SpecClause } from "../../types.js";
import { replayKnowledgeLog } from "../log.js";
import { applyProposalEnrichment, proposeDomainsFromSpec } from "./spec-proposals.js";
import { proposeCodeGaps } from "./code-gaps.js";
import { editDomain, validateDomainHierarchy } from "./hierarchy.js";
import { analyzeCodeAssignment } from "./assignments.js";
import { applyGateA } from "./gate-a.js";
import { applyGateB } from "./gate-b.js";
import { applyGateC } from "./gate-c.js";
import { classifyDomainDrift, proposeSemanticDomainChanges } from "./drift.js";
import { buildDomainOrganizationView } from "./organization-view.js";
import type { ApprovedDomain, CodeSymbolEvidence, DomainProposal } from "./types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const clause = (id: string, heading: string, text: string, domainRefs: string[] = []): SpecClause => ({
  id, sourceFile: "spec/feature/game.md", heading, text, domainRefs, embedding: null,
});

const revision = { sourceRevision: "sha256:spec", contentFingerprint: "sha256:domain" };
const domain = (id: string, assignable = true): ApprovedDomain => ({
  id, name: id, purpose: id, responsibilities: [], boundary: { inScope: [], outOfScope: [] }, assignable, aliases: [], revision,
});

describe("spec-only domain proposals", () => {
  it("groups only authored clauses and does not use code paths as semantic names", () => {
    const proposals = proposeDomainsFromSpec({
      projectId: "game",
      clauses: [
        clause("spec:game/a#one", "Combat / Rules", "Resolve a hit in `src/combat/resolve.ts`.", ["domain:game/combat"]),
        clause("spec:game/a#two", "Combat / Rules", "Apply damage." , ["domain:game/combat"]),
      ],
      sourceRevision: "sha256:spec",
      analysisSnapshotId: "analysis:one",
      expectedHead: null,
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].name).toBe("combat");
    expect(proposals[0].purpose).not.toContain("src/combat");
    expect(proposals[0].sourceClauseIds).toEqual(["spec:game/a#one", "spec:game/a#two"]);
    expect(proposals[0].evidence.llm).toEqual([]);
  });

  it("keeps proposing when an authored heading contains a bare percent sign", () => {
    const proposals = proposeDomainsFromSpec({
      projectId: "game",
      clauses: [
        clause("spec:game/b#one", "100% completion / Rules", "Track completion."),
        clause("spec:game/c#one", "Combat", "Resolve a hit."),
      ],
      sourceRevision: "sha256:spec",
      analysisSnapshotId: "analysis:one",
      expectedHead: null,
    });
    expect(proposals.map((proposal) => proposal.name)).toEqual(["100% completion", "Combat"]);
  });

  it("records enrichment as extra evidence without dropping the deterministic pass", () => {
    const [base] = proposeDomainsFromSpec({
      projectId: "game",
      clauses: [clause("spec:game/a#one", "Combat", "Resolve a hit.")],
      sourceRevision: "sha256:spec",
      analysisSnapshotId: "analysis:one",
      expectedHead: null,
    });
    const enriched = applyProposalEnrichment(
      base,
      { purpose: "Resolve combat outcomes" },
      { field: "purpose", value: "Resolve combat outcomes", confidence: 0.6 },
    );
    expect(enriched.candidateId).toBe(base.candidateId);
    expect(enriched.purpose).toBe("Resolve combat outcomes");
    expect(enriched.evidence.deterministic).toEqual(base.evidence.deterministic);
    expect(enriched.evidence.llm).toHaveLength(1);
    expect(base.evidence.llm).toHaveLength(0);
  });
});

describe("domain hierarchy", () => {
  it("rejects cycles, multiple parents, dangling parents, and aggregate assignments", () => {
    const domains = [domain("domain:p/a"), domain("domain:p/b"), domain("domain:p/c", false)];
    expect(() => validateDomainHierarchy(domains, [
      { childId: "domain:p/a", parentId: "domain:p/b" },
      { childId: "domain:p/b", parentId: "domain:p/a" },
    ])).toThrow(/cycle/);
    expect(() => validateDomainHierarchy(domains, [
      { childId: "domain:p/a", parentId: "domain:p/b" },
      { childId: "domain:p/a", parentId: "domain:p/c" },
    ])).toThrow(/multiple/);
    expect(() => validateDomainHierarchy(domains, [{ childId: "domain:p/a", parentId: "domain:p/missing" }])).toThrow(/dangling/);
    expect(() => validateDomainHierarchy(domains, [], ["domain:p/c"])).toThrow(/aggregate/);
  });

  it("keeps the immutable id through display and parent edits", () => {
    const original = domain("domain:p/a");
    expect(editDomain(original, { name: "Renamed" }).id).toBe(original.id);
    expect(() => editDomain(original, { id: "domain:p/other" })).toThrow(/immutable/);
  });
});

const symbol: CodeSymbolEvidence = {
  symbolId: "code:p/cpp/resolve", language: "cpp", qualifiedName: "Combat::resolve(Hit)",
  sourcePath: "src/combat.cpp", startLine: 10, endLine: 20, signature: "void resolve(Hit)",
  signatureShape: "Combat::resolve(Hit)", sourceRevision: "git:a", contentFingerprint: "sha256:code",
};

describe("exact code assignment", () => {
  it("assigns only with authoritative evidence and abstains on path-only evidence", () => {
    const assigned = analyzeCodeAssignment(symbol, [{
      domainId: "domain:p/combat",
      evidence: [{ kind: "ratified-spec-link", detail: "exact clause link", confidence: 0.95, sourceAnchor: symbol.symbolId }],
    }], null, "analysis:a", null);
    expect(assigned.action).toBe("assign-existing");
    expect(assigned.afterOwner).toBe("domain:p/combat");

    const abstained = analyzeCodeAssignment(symbol, [{
      domainId: "domain:p/combat",
      evidence: [{ kind: "path-pattern", detail: "src/combat", confidence: 1 }],
    }], null, "analysis:a", null);
    expect(abstained.action).toBe("abstain");
  });
});

describe("code-only clusters", () => {
  it("keeps each connected component a Gate A proposal and never an approval", () => {
    const neighbor: CodeSymbolEvidence = {
      ...symbol, symbolId: "code:p/cpp/apply", qualifiedName: "Combat::apply(Hit)", startLine: 30, endLine: 40,
    };
    const lone: CodeSymbolEvidence = {
      ...symbol, symbolId: "code:p/cpp/log", qualifiedName: "Log::write(Line)", sourcePath: "src/log.cpp", startLine: 1, endLine: 5,
    };
    const proposals = proposeCodeGaps({
      symbols: [symbol, neighbor, lone],
      calls: [{ from: symbol.symbolId, to: neighbor.symbolId }],
      linkedClauseIdsBySymbol: new Map([[symbol.symbolId, ["spec:p/rules#one"]]]),
    });
    expect(proposals).toHaveLength(2);
    const cluster = proposals.find((proposal) => proposal.symbolIds.length === 2)!;
    expect(cluster.kind).toBe("emergent-domain");
    expect(cluster.cohesion).toBe(0.5);
    const solo = proposals.find((proposal) => proposal.symbolIds.length === 1)!;
    expect(solo.kind).toBe("spec-gap");
    expect(solo.cohesion).toBe(0);
    expect(proposals.every((proposal) => proposal.requiresGate === "gate-a")).toBe(true);
    expect(cluster.requiredSpecDraft).toContain("Boundary");
  });
});

describe("drift reconciliation", () => {
  it("keeps overlap and boundary drift as semantic Gate C proposals", () => {
    const findings = classifyDomainDrift({
      domainId: "domain:p/a",
      clauseIds: ["spec:p/a#one"],
      symbolIds: [symbol.symbolId],
      expectedSymbolIds: [symbol.symbolId],
      overlapDomainIds: ["domain:p/b"],
      boundaryDriftEvidence: ["approved out-of-scope rule is now reached"],
    });
    expect(findings.map((finding) => finding.kind)).toEqual(["overlap", "boundary-drift"]);
    const proposals = proposeSemanticDomainChanges(findings, {
      sourceRevision: "sha256:spec",
      analysisSnapshotId: "analysis:drift",
      expectedHead: "sha256:head",
    });
    expect(proposals.map((proposal) => proposal.kind).sort()).toEqual(["merge", "split"]);
    expect(proposals.every((proposal) => proposal.requiresGate === "gate-c")).toBe(true);
  });
});

describe("organization view", () => {
  it("shows analyzed code that has not entered the knowledge log yet", () => {
    const state = replayKnowledgeLog("");
    const view = buildDomainOrganizationView(state, [{
      id: symbol.symbolId,
      anchorId: "anchor:one",
      qualifiedName: symbol.qualifiedName,
      sourcePath: symbol.sourcePath,
      sourceRange: { startLine: symbol.startLine, endLine: symbol.endLine },
    }]);
    expect(view.unassignedCodeSymbols).toEqual([expect.objectContaining({
      id: symbol.symbolId,
      anchorId: "anchor:one",
    })]);
  });
});

describe("Gate A/B canonical apply", () => {
  it("rolls domain OKF back when canonical owner validation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-gate-a-"));
    roots.push(root);
    const makeProposal = (id: string): DomainProposal => ({
      ...proposeDomainsFromSpec({
        projectId: "p", clauses: [clause("spec:p/rules#shared", id, "Responsibility")],
        sourceRevision: "sha256:spec", analysisSnapshotId: "analysis:a", expectedHead: null,
      })[0],
      proposalId: `proposal:${id}`,
      candidateId: `domain:p/${id}`,
      name: id,
    });
    const request = {
      confirmApply: true,
      repoRoot: root,
      service: "p",
      domainRoot: join(root, "spec", "data", "domains"),
      knowledgeLogPath: join(root, "spec", "data", "domain-map", "p.knowledge.jsonl"),
      proposals: [makeProposal("a"), makeProposal("b")],
      hierarchy: [],
      sourceRevision: "sha256:spec",
      analysisSnapshotId: "analysis:a",
      expectedHead: null,
      reviewRef: "PR-1",
    };
    await expect(applyGateA(request)).rejects.toThrow(/multiple semantic owners/);
    await expect(readFile(request.knowledgeLogPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(request.domainRoot)).toEqual([]);
  });

  it("persists approved domains then applies exact existing-domain assignment", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-gate-b-"));
    roots.push(root);
    const proposal = proposeDomainsFromSpec({
      projectId: "p", clauses: [clause("spec:p/rules#one", "Combat", "Resolve combat")],
      sourceRevision: "sha256:spec", analysisSnapshotId: "analysis:a", expectedHead: null,
    })[0];
    const logPath = join(root, "spec", "data", "domain-map", "p.knowledge.jsonl");
    const gateA = await applyGateA({
      confirmApply: true, repoRoot: root, service: "p", domainRoot: join(root, "spec", "data", "domains"),
      knowledgeLogPath: logPath, proposals: [proposal], hierarchy: [], sourceRevision: "sha256:spec",
      analysisSnapshotId: "analysis:a", expectedHead: null, reviewRef: "PR-1",
    });
    const action = analyzeCodeAssignment(symbol, [{
      domainId: proposal.candidateId,
      evidence: [{ kind: "explicit-annotation", detail: "@domain", confidence: 1, sourceAnchor: symbol.symbolId }],
    }], null, "analysis:b", gateA.transaction.transactionHash);
    const gateB = await applyGateB({
      confirmApply: true, repoRoot: root, knowledgeLogPath: logPath, actions: [action], analysisSnapshotId: "analysis:b",
      expectedHead: gateA.transaction.transactionHash, codeRevision: "git:a", reviewRef: "PR-2",
    });
    const state = replayKnowledgeLog(await readFile(logPath, "utf8"));
    expect(state.head).toBe(gateB.transaction.transactionHash);
    expect([...state.edges.values()].some((edge) => edge.kind === "domain-owns-code" && edge.to === symbol.symbolId)).toBe(true);

    // Approving an abstain records the symbol revision but leaves every edge —
    // including related/consumer edges — exactly as the previous Gate left them.
    const abstain = {
      ...action,
      proposalId: "proposal:assignment/abstain",
      action: "abstain" as const,
      beforeOwner: proposal.candidateId,
      afterOwner: proposal.candidateId,
      relatedDomainIds: ["domain:p/never-approved"],
      analysisSnapshotId: "analysis:c",
      expectedHead: gateB.transaction.transactionHash,
    };
    const gateBAbstain = await applyGateB({
      confirmApply: true, repoRoot: root, knowledgeLogPath: logPath, actions: [abstain], analysisSnapshotId: "analysis:c",
      expectedHead: gateB.transaction.transactionHash, codeRevision: "git:a", reviewRef: "PR-3",
    });
    expect(gateBAbstain.transaction.operations.every((operation) => operation.op === "upsert-node")).toBe(true);
    const after = replayKnowledgeLog(await readFile(logPath, "utf8"));
    expect([...after.edges.values()].map((edge) => edge.id).sort())
      .toEqual([...state.edges.values()].map((edge) => edge.id).sort());
  });

  it("rolls semantic OKF back when Gate C would leave a dangling edge", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-gate-c-"));
    roots.push(root);
    const proposal = proposeDomainsFromSpec({
      projectId: "p", clauses: [clause("spec:p/rules#one", "Combat", "Resolve combat")],
      sourceRevision: "sha256:spec", analysisSnapshotId: "analysis:a", expectedHead: null,
    })[0];
    const logPath = join(root, "spec", "data", "domain-map", "p.knowledge.jsonl");
    const gateA = await applyGateA({
      confirmApply: true, repoRoot: root, service: "p", domainRoot: join(root, "spec", "data", "domains"),
      knowledgeLogPath: logPath, proposals: [proposal], hierarchy: [], sourceRevision: "sha256:spec",
      analysisSnapshotId: "analysis:a", expectedHead: null, reviewRef: "PR-1",
    });
    const okfPath = join(root, "spec", "data", "domains", "split.md");
    await expect(applyGateC({
      confirmApply: true,
      repoRoot: root,
      workflowRoot: join(root, "spec"),
      kind: "split",
      proposals: [{
        proposalId: "proposal:domain-split/one",
        kind: "split",
        affectedDomainIds: [proposal.candidateId],
        affectedSymbolIds: [],
        affectedClauseIds: proposal.sourceClauseIds,
        evidence: ["boundary drift"],
        unresolvedQuestions: [],
        sourceRevision: "sha256:spec",
        analysisSnapshotId: "analysis:c",
        expectedHead: gateA.transaction.transactionHash,
        requiresGate: "gate-c",
      }],
      knowledgeLogPath: logPath,
      okfWrites: [{ path: okfPath, content: "---\ntype: data\n---\n", expectedContentHash: null }],
      operations: [{ op: "remove-node", id: proposal.candidateId }],
      sourceRevision: "sha256:spec",
      analysisSnapshotId: "analysis:c",
      expectedHead: gateA.transaction.transactionHash,
      reviewRef: "PR-2",
    })).rejects.toThrow(/dangling edge/);
    await expect(readFile(okfPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(replayKnowledgeLog(await readFile(logPath, "utf8")).head).toBe(gateA.transaction.transactionHash);
  });
});
