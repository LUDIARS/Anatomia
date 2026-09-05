/**
 * src/knowledge/domain/relation-approval.ts — Writing approved context-map
 * relations to the knowledge log (design §7.2 A-8, approval half).
 *
 * Same shape as Gate A: a draft (relation-llm.ts) is NOT data; only what a
 * human approved reaches the canonical log, under `origin: "human-approval"`
 * with the reviewRef recorded. The log rejects an edge whose endpoints are not
 * already nodes, so a relation naming a domain the log does not have is
 * REPORTED as skipped rather than written or silently dropped
 * (memory: anatomia-knowledge-edge-endpoints).
 *
 * SRP: proposal → knowledge transaction. No drafting, no aggregation.
 *
 * @spec コアドメイン間の関係辺（コンテキストマップ、A-8）
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { replayKnowledgeLog, writeKnowledgeTransaction } from "../log.js";
import type { KnowledgeGraph, KnowledgeOperation, KnowledgeTransaction } from "../types.js";
import {
  domainRelationEdgeId,
  isDomainRelationKind,
  type ApprovedDomainRelation,
  type DomainRelationProposal,
} from "./relation-types.js";

/** An approval request for one batch of relations. */
export interface DomainRelationApprovalRequest {
  confirmApply: boolean;
  knowledgeLogPath: string;
  relations: ApprovedDomainRelation[];
  analysisSnapshotId: string;
  expectedHead: string | null;
  reviewRef: string | null;
}

/** What the approval wrote, and what it refused to write. */
export interface DomainRelationApprovalResult {
  transaction: KnowledgeTransaction;
  written: ApprovedDomainRelation[];
  /** Relations whose endpoints the log does not know, with the reason. */
  skipped: Array<{ relation: ApprovedDomainRelation; reason: string }>;
}

/** Turn an approved proposal into the approval record the log stores. */
export function approveRelation(
  proposal: DomainRelationProposal,
  overrides: Partial<Pick<ApprovedDomainRelation, "relation" | "rationale">> = {},
): ApprovedDomainRelation {
  return {
    fromDomainId: proposal.fromDomainId,
    toDomainId: proposal.toDomainId,
    relation: overrides.relation ?? proposal.relation,
    rationale: overrides.rationale ?? proposal.rationale,
    proposalId: proposal.proposalId,
  };
}

/**
 * Split the relations into the ones the current log can hold and the ones it
 * cannot, without touching the log. Exposed so a caller can show a reviewer
 * what would be skipped BEFORE asking them to approve it.
 */
export function partitionByKnownEndpoints(
  state: KnowledgeGraph,
  relations: readonly ApprovedDomainRelation[],
): { writable: ApprovedDomainRelation[]; skipped: Array<{ relation: ApprovedDomainRelation; reason: string }> } {
  const writable: ApprovedDomainRelation[] = [];
  const skipped: Array<{ relation: ApprovedDomainRelation; reason: string }> = [];
  for (const relation of relations) {
    const missing = [relation.fromDomainId, relation.toDomainId]
      .filter((id) => state.nodes.get(id)?.kind !== "domain");
    if (missing.length > 0) {
      skipped.push({ relation, reason: `knowledge log has no approved domain: ${missing.join(", ")}` });
      continue;
    }
    if (relation.fromDomainId === relation.toDomainId) {
      skipped.push({ relation, reason: "a domain cannot relate to itself" });
      continue;
    }
    writable.push(relation);
  }
  return { writable, skipped };
}

/** Write the approved relations as one human-approval transaction. */
export async function applyDomainRelations(
  request: DomainRelationApprovalRequest,
): Promise<DomainRelationApprovalResult> {
  if (!request.confirmApply) throw new Error("domain relation approval requires confirmApply=true");
  if (request.relations.length === 0) throw new Error("domain relation approval requires at least one relation");
  const relationEdgeIds = new Set<string>();
  for (const relation of request.relations) {
    if (!relation || typeof relation.fromDomainId !== "string" || relation.fromDomainId === ""
      || typeof relation.toDomainId !== "string" || relation.toDomainId === "") {
      throw new Error("domain relation approval requires non-empty fromDomainId and toDomainId");
    }
    if (!isDomainRelationKind(relation.relation)) {
      throw new Error(`unsupported domain relation kind: ${String(relation.relation)}`);
    }
    if (typeof relation.rationale !== "string"
      || (relation.proposalId !== null && typeof relation.proposalId !== "string")) {
      throw new Error("domain relation approval requires a rationale and a string or null proposalId");
    }
    const edgeId = domainRelationEdgeId(relation);
    if (relationEdgeIds.has(edgeId)) throw new Error(`duplicate domain relation approval: ${edgeId}`);
    relationEdgeIds.add(edgeId);
  }

  const state = replayKnowledgeLog(await readLog(request.knowledgeLogPath));
  if (state.head !== request.expectedHead) {
    throw new Error(`domain relation head conflict: expected ${request.expectedHead}, got ${state.head}`);
  }
  const { writable, skipped } = partitionByKnownEndpoints(state, request.relations);
  if (writable.length === 0) {
    throw new Error(`no approved relation has both endpoints in the knowledge log: ${skipped.map((entry) => entry.reason).join("; ")}`);
  }

  const operations: KnowledgeOperation[] = writable
    .map((relation) => ({
      op: "upsert-edge" as const,
      record: {
        id: domainRelationEdgeId(relation),
        kind: "domain-relates-domain" as const,
        from: relation.fromDomainId,
        to: relation.toDomainId,
        evidence: {
          relation: relation.relation,
          rationale: relation.rationale,
          ...(relation.proposalId ? { proposalId: relation.proposalId } : {}),
        },
      },
    }))
    .sort((left, right) => left.record.id.localeCompare(right.record.id));

  const transaction = await writeKnowledgeTransaction(request.knowledgeLogPath, {
    transactionId: relationTransactionId(writable, request.expectedHead),
    analysisSnapshotId: request.analysisSnapshotId,
    sourceRevisions: { spec: null, code: null, trace: null },
    origin: "human-approval",
    operations,
    provenance: {
      proposalIds: writable.map((relation) => relation.proposalId).filter((id): id is string => id !== null).sort(),
      approval: { kind: "human", reviewRef: request.reviewRef },
      generatorSchema: 1,
    },
  }, request.expectedHead);

  return { transaction, written: writable, skipped };
}

async function readLog(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function relationTransactionId(
  relations: readonly ApprovedDomainRelation[],
  expectedHead: string | null,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      expectedHead,
      relations: [...relations]
        .sort((left, right) => domainRelationEdgeId(left).localeCompare(domainRelationEdgeId(right)))
        .map((relation) => ({
          edgeId: domainRelationEdgeId(relation),
          relation: relation.relation,
          rationale: relation.rationale,
          proposalId: relation.proposalId,
        })),
    }), "utf8")
    .digest("hex").slice(0, 24);
  return `tx:domain-relations/${digest}`;
}
