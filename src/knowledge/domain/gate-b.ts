import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withDomainWorkflowLock } from "../../domains/workflow/keyed-mutex.js";
import { replayKnowledgeLog, writeKnowledgeTransaction } from "../log.js";
import type { KnowledgeGraph, KnowledgeOperation, KnowledgeTransaction } from "../types.js";
import type { DomainAssignmentAction } from "./types.js";

export interface GateBRequest {
  confirmApply: boolean;
  repoRoot: string;
  knowledgeLogPath: string;
  actions: DomainAssignmentAction[];
  analysisSnapshotId: string;
  expectedHead: string | null;
  codeRevision: string;
  reviewRef: string | null;
  residualAnalysis?: () => Promise<unknown>;
  rebuildProjections?: () => Promise<void>;
}

export interface GateBResult {
  transaction: KnowledgeTransaction;
  residual: unknown;
  canonicalCommitted: true;
  projectionsStale: boolean;
}

async function stateAt(path: string): Promise<KnowledgeGraph> {
  try { return replayKnowledgeLog(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return replayKnowledgeLog("");
    throw error;
  }
}

function currentOwner(state: KnowledgeGraph, symbolId: string): string | null {
  return [...state.edges.values()].find((edge) => edge.kind === "domain-owns-code" && edge.to === symbolId)?.from ?? null;
}

function alreadyApproved(state: KnowledgeGraph, proposalId: string): boolean {
  return state.transactions.some((transaction) => transaction.provenance.proposalIds.includes(proposalId));
}

function transactionId(actions: DomainAssignmentAction[]): string {
  const digest = createHash("sha256").update(actions.map((action) => action.proposalId).sort().join("\n"), "utf8")
    .digest("hex").slice(0, 24);
  return `tx:gate-b/${digest}`;
}

export async function applyGateB(request: GateBRequest): Promise<GateBResult> {
  if (!request.confirmApply) throw new Error("Gate B requires confirmApply=true");
  if (request.actions.length === 0) throw new Error("Gate B requires at least one assignment action");
  const transaction = await withDomainWorkflowLock(request.repoRoot, dirname(request.knowledgeLogPath), async () => {
    const state = await stateAt(request.knowledgeLogPath);
    if (state.head !== request.expectedHead) throw new Error(`Gate B head conflict: expected ${request.expectedHead}, got ${state.head}`);

    const operations: KnowledgeOperation[] = [];
    for (const action of request.actions) {
      if (action.analysisSnapshotId !== request.analysisSnapshotId || action.expectedHead !== request.expectedHead) {
        throw new Error(`stale assignment proposal ${action.proposalId}`);
      }
      if (action.symbol.sourceRevision !== request.codeRevision) throw new Error(`stale code evidence ${action.proposalId}`);
      if (alreadyApproved(state, action.proposalId)) throw new Error(`assignment proposal already approved: ${action.proposalId}`);
      const actualOwner = currentOwner(state, action.symbol.symbolId);
      if (actualOwner !== action.beforeOwner) throw new Error(`assignment before-owner conflict for ${action.symbol.symbolId}`);
      if (action.afterOwner) {
        const domain = state.nodes.get(action.afterOwner);
        if (!domain || domain.kind !== "domain") throw new Error(`assignment target is not an approved domain: ${action.afterOwner}`);
        if (domain.data?.assignable === false) throw new Error(`aggregate domain cannot own code: ${action.afterOwner}`);
      }
      operations.push({ op: "upsert-node", record: {
        id: action.symbol.symbolId,
        kind: "code-symbol",
        revision: {
          sourceRevision: action.symbol.sourceRevision,
          contentFingerprint: action.symbol.contentFingerprint,
          sourcePath: action.symbol.sourcePath,
          sourceRange: { startLine: action.symbol.startLine, endLine: action.symbol.endLine },
        },
        data: {
          language: action.symbol.language,
          qualifiedName: action.symbol.qualifiedName,
          signature: action.symbol.signature,
          signatureShape: action.symbol.signatureShape,
        },
      } });
      if (actualOwner && actualOwner !== action.afterOwner) {
        for (const edge of state.edges.values()) {
          if (edge.kind === "domain-owns-code" && edge.to === action.symbol.symbolId) {
            operations.push({ op: "remove-edge", id: edge.id });
          }
        }
      }
      if (action.afterOwner && action.action !== "abstain") {
        operations.push({ op: "upsert-edge", record: {
          id: `domain-owns-code:${action.afterOwner}->${action.symbol.symbolId}`,
          kind: "domain-owns-code",
          from: action.afterOwner,
          to: action.symbol.symbolId,
          evidence: {
            proposalId: action.proposalId,
            rationale: action.rationale,
            confidence: action.confidence,
            positive: action.positiveEvidence,
            negative: action.negativeEvidence,
          },
        } });
      }
      // `abstain` records the symbol but states that the evidence does not
      // support an ownership decision, so it must not rewrite related edges
      // either — approving it leaves the existing graph as it is.
      if (action.action === "abstain") continue;
      for (const edge of state.edges.values()) {
        if (edge.kind === "domain-uses-code" && edge.to === action.symbol.symbolId
          && !action.relatedDomainIds.includes(edge.from)) {
          operations.push({ op: "remove-edge", id: edge.id });
        }
      }
      for (const domainId of action.relatedDomainIds) {
        if (!state.nodes.has(domainId)) throw new Error(`related assignment references unknown domain ${domainId}`);
        operations.push({ op: "upsert-edge", record: {
          id: `domain-uses-code:${domainId}->${action.symbol.symbolId}`,
          kind: "domain-uses-code",
          from: domainId,
          to: action.symbol.symbolId,
          evidence: { proposalId: action.proposalId },
        } });
      }
    }

    return writeKnowledgeTransaction(request.knowledgeLogPath, {
      transactionId: transactionId(request.actions),
      analysisSnapshotId: request.analysisSnapshotId,
      sourceRevisions: { spec: null, code: request.codeRevision, trace: null },
      origin: "human-approval",
      operations,
      provenance: {
        proposalIds: request.actions.map((action) => action.proposalId),
        approval: { kind: "human", reviewRef: request.reviewRef },
        generatorSchema: 1,
      },
    }, request.expectedHead);
  });
  let projectionsStale = false;
  if (request.rebuildProjections) {
    try { await request.rebuildProjections(); }
    catch { projectionsStale = true; }
  }
  const residual = request.residualAnalysis ? await request.residualAnalysis() : null;
  return { transaction, residual, canonicalCommitted: true, projectionsStale };
}
