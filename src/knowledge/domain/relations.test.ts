import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { replayKnowledgeLog, writeKnowledgeTransaction } from "../log.js";
import type { DomainCorrespondenceQuery } from "../domain-correspondence/types.js";
import type { KnowledgeGraph, KnowledgeNode } from "../types.js";
import { collectDomainRelationCandidates } from "./relation-candidates.js";
import {
  draftDomainRelationsDeterministically,
  parseRelationDraft,
} from "./relation-llm.js";
import { applyDomainRelations, approveRelation, partitionByKnownEndpoints } from "./relation-approval.js";
import { buildBusinessDomainViewPayload } from "../../web-cache/business-domain-view.js";
import type { SceneInspection } from "../scene/types.js";

function correspondence(pairs: Array<[string, string[]]>): DomainCorrespondenceQuery {
  return {
    programDomains: pairs.map(([programDomainId, owners]) => ({
      programDomainId,
      businessDomains: owners.map((businessDomainId) => ({
        businessDomainId,
        weight: 1,
        evidence: { codeSymbols: [], specClauses: [] },
      })),
      unlinkedCodeSymbols: [],
      unlinkedCodeSymbolCount: 0,
    })),
    businessDomains: [],
    specClauses: [],
  };
}

function domainNode(id: string): KnowledgeNode {
  return {
    id,
    kind: "domain",
    revision: { sourceRevision: "r1", contentFingerprint: "f1" },
    data: { name: id },
  };
}

function graphWith(nodes: KnowledgeNode[]): KnowledgeGraph {
  return {
    head: null,
    transactions: [],
    nodes: new Map(nodes.map((node) => [node.id, node])),
    edges: new Map(),
  };
}

const EMPTY_SCENES: SceneInspection = {
  scenes: [],
  manifest: { knowledgeHead: null, sourceRevision: "r1", projectionSchema: 1 },
  stale: false,
  staleReasons: [],
} as unknown as SceneInspection;

describe("collectDomainRelationCandidates", () => {
  it("folds program-domain dependencies through business ownership", () => {
    const candidates = collectDomainRelationCandidates(
      correspondence([["p-ui", ["rendering"]], ["p-core", ["geometry"]]]),
      [{ from: "p-ui", to: "p-core", weight: 4 }],
    );
    expect(candidates).toEqual([{
      fromDomainId: "rendering",
      toDomainId: "geometry",
      weight: 4,
      programDomainPairs: [{ from: "p-ui", to: "p-core", weight: 4 }],
    }]);
  });

  it("drops self-pairs and honours the weight floor", () => {
    const candidates = collectDomainRelationCandidates(
      correspondence([["p-a", ["rendering"]], ["p-b", ["rendering"]], ["p-c", ["geometry"]]]),
      [{ from: "p-a", to: "p-b", weight: 9 }, { from: "p-a", to: "p-c", weight: 1 }],
      { minWeight: 2 },
    );
    expect(candidates).toEqual([]);
  });
});

describe("relation drafting", () => {
  const candidates = collectDomainRelationCandidates(
    correspondence([["p-ui", ["rendering"]], ["p-core", ["geometry"]]]),
    [{ from: "p-ui", to: "p-core", weight: 4 }],
  );

  it("keeps only pairs the deterministic aggregation produced", () => {
    const answer = JSON.stringify({
      relations: [
        { from: "rendering", to: "geometry", relation: "shared-kernel", rationale: "共有の頂点表現" },
        { from: "rendering", to: "invented", relation: "depends-on", rationale: "でっちあげ" },
      ],
    });
    const proposals = parseRelationDraft(answer, candidates);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ relation: "shared-kernel", draft: true });
  });

  it("says so when the deterministic draft did not judge the relation kind", () => {
    const [draft] = draftDomainRelationsDeterministically(candidates);
    expect(draft!.relation).toBe("depends-on");
    expect(draft!.rationale).toContain("未判定");
  });
});

describe("relation approval", () => {
  const candidates = collectDomainRelationCandidates(
    correspondence([["p-ui", ["rendering"]], ["p-core", ["geometry"]]]),
    [{ from: "p-ui", to: "p-core", weight: 4 }],
  );
  const [proposal] = draftDomainRelationsDeterministically(candidates);

  it("refuses to write an edge whose endpoint the log does not know", () => {
    const state = graphWith([domainNode("rendering")]);
    const { writable, skipped } = partitionByKnownEndpoints(state, [approveRelation(proposal!)]);
    expect(writable).toEqual([]);
    expect(skipped[0]!.reason).toContain("geometry");
  });

  it("writes only the approved relation and the view shows only what was written", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-relations-"));
    const logPath = join(root, "log.jsonl");
    const seeded = await writeKnowledgeTransaction(logPath, {
      transactionId: "tx:seed",
      analysisSnapshotId: "snap",
      sourceRevisions: { spec: "r1", code: null, trace: null },
      origin: "human-approval",
      operations: [
        { op: "upsert-node", record: domainNode("rendering") },
        { op: "upsert-node", record: domainNode("geometry") },
      ],
      provenance: { proposalIds: [], approval: { kind: "human", reviewRef: null }, generatorSchema: 1 },
    }, null);

    const before = buildBusinessDomainViewPayload(
      replayKnowledgeLog(await readText(logPath)),
      correspondence([]),
      EMPTY_SCENES,
    );
    // The draft exists but was never approved, so it cannot reach the view.
    expect(before.relations).toEqual([]);

    const result = await applyDomainRelations({
      confirmApply: true,
      knowledgeLogPath: logPath,
      relations: [approveRelation(proposal!, { relation: "shared-kernel", rationale: "共有カーネル" })],
      analysisSnapshotId: "snap",
      expectedHead: seeded.transactionHash,
      reviewRef: "discord://review/1",
    });
    expect(result.written).toHaveLength(1);
    expect(result.transaction.origin).toBe("human-approval");

    const after = buildBusinessDomainViewPayload(
      replayKnowledgeLog(await readText(logPath)),
      correspondence([]),
      EMPTY_SCENES,
    );
    expect(after.relations).toEqual([
      { from: "rendering", to: "geometry", relation: "shared-kernel", rationale: "共有カーネル" },
    ]);
    expect(after.domains.find((domain) => domain.id === "rendering")?.relatedDomainIds)
      .toEqual(["geometry"]);

    const corrected = await applyDomainRelations({
      confirmApply: true,
      knowledgeLogPath: logPath,
      relations: [approveRelation(proposal!, { relation: "depends-on", rationale: "方向を再確認" })],
      analysisSnapshotId: "snap-2",
      expectedHead: result.transaction.transactionHash,
      reviewRef: "discord://review/2",
    });
    expect(corrected.transaction.transactionId).not.toBe(result.transaction.transactionId);
    const correctedEdge = replayKnowledgeLog(await readText(logPath)).edges
      .get("domain-relates-domain:rendering->geometry");
    expect(correctedEdge?.evidence).toMatchObject({ relation: "depends-on", rationale: "方向を再確認" });
  });
});

async function readText(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}
