import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileRollback } from "../../domains/workflow/file-rollback.js";
import { withDomainWorkflowLock } from "../../domains/workflow/keyed-mutex.js";
import { replayKnowledgeLog, writeKnowledgeTransaction } from "../log.js";
import type { KnowledgeOperation, KnowledgeTransaction } from "../types.js";
import { contentHash } from "./domain-okf.js";
import type { SemanticDomainProposal } from "./types.js";

export interface SemanticOkfWrite {
  path: string;
  content: string;
  expectedContentHash: string | null;
}

export interface GateCRequest {
  confirmApply: boolean;
  repoRoot: string;
  workflowRoot: string;
  kind: "split" | "merge" | "boundary" | "hierarchy";
  proposals: SemanticDomainProposal[];
  knowledgeLogPath: string;
  okfWrites: SemanticOkfWrite[];
  operations: KnowledgeOperation[];
  sourceRevision: string;
  analysisSnapshotId: string;
  expectedHead: string | null;
  reviewRef: string | null;
  residualAnalysis?: () => Promise<unknown>;
  rebuildProjections?: () => Promise<void>;
}

async function optional(path: string): Promise<Buffer | null> {
  try { return await readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function applyGateC(request: GateCRequest): Promise<{
  transaction: KnowledgeTransaction;
  residual: unknown;
  canonicalCommitted: true;
  projectionsStale: boolean;
}> {
  if (!request.confirmApply) throw new Error("Gate C requires confirmApply=true");
  if (request.proposals.length === 0) throw new Error("Gate C requires proposals");
  if (request.proposals.some((proposal) => proposal.kind !== request.kind)) {
    throw new Error("Gate C proposal kind does not match the requested operation");
  }
  for (const proposal of request.proposals) {
    if (proposal.sourceRevision !== request.sourceRevision
      || proposal.analysisSnapshotId !== request.analysisSnapshotId
      || proposal.expectedHead !== request.expectedHead) {
      throw new Error(`stale semantic proposal ${proposal.proposalId}`);
    }
  }
  const proposalIds = request.proposals.map((proposal) => proposal.proposalId);
  if (new Set(proposalIds).size !== proposalIds.length) throw new Error("Gate C contains duplicate proposals");
  const transaction = await withDomainWorkflowLock(request.repoRoot, request.workflowRoot, async () => {
    const before = await optional(request.knowledgeLogPath);
    const state = replayKnowledgeLog(before?.toString("utf8") ?? "");
    if (state.head !== request.expectedHead) throw new Error(`Gate C head conflict: expected ${request.expectedHead}, got ${state.head}`);
    for (const proposalId of proposalIds) {
      if (state.transactions.some((candidate) => candidate.provenance.proposalIds.includes(proposalId))) {
        throw new Error(`semantic proposal already approved: ${proposalId}`);
      }
    }
    for (const write of request.okfWrites) {
      const current = await optional(write.path);
      if (current && (write.expectedContentHash === null || contentHash(current) !== write.expectedContentHash)) {
        throw new Error(`semantic OKF merge conflict: ${write.path}`);
      }
    }
    const digest = createHash("sha256").update(proposalIds.slice().sort().join("\n"), "utf8").digest("hex").slice(0, 24);
    return withFileRollback(
      [request.knowledgeLogPath, ...request.okfWrites.map((write) => write.path)],
      async () => {
        for (const write of request.okfWrites) {
          await mkdir(dirname(write.path), { recursive: true });
          await writeFile(write.path, write.content.replace(/\r\n?/g, "\n"), "utf8");
        }
        return writeKnowledgeTransaction(request.knowledgeLogPath, {
          transactionId: `tx:gate-c/${request.kind}/${digest}`,
          analysisSnapshotId: request.analysisSnapshotId,
          sourceRevisions: { spec: request.sourceRevision, code: null, trace: null },
          origin: "human-approval",
          operations: request.operations,
          provenance: {
            proposalIds,
            approval: { kind: "human", reviewRef: request.reviewRef },
            generatorSchema: 1,
          },
        }, request.expectedHead);
      },
    );
  });
  let projectionsStale = false;
  if (request.rebuildProjections) {
    try { await request.rebuildProjections(); }
    catch { projectionsStale = true; }
  }
  const residual = request.residualAnalysis ? await request.residualAnalysis() : null;
  return { transaction, residual, canonicalCommitted: true, projectionsStale };
}
