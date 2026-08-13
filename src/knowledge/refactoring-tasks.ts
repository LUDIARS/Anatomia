// @spec リファクタリング提案生成 + 調整タスク発行 (task sink)

import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { KnowledgeHeadConflictError, writeKnowledgeTransaction } from "./log.js";
import type { RefactoringProposal } from "../review/refactoring-proposals.js";
import type { KnowledgeProjectPort } from "./application/port.js";
import { DomainKnowledgeApplication } from "./application/domain-application.js";

export type RefactoringTaskStatus = "open" | "done";
export interface RefactoringTask { id: string; status: RefactoringTaskStatus; }
export interface RefactoringTaskSink { issue(proposal: RefactoringProposal): Promise<RefactoringTask>; }

function taskFromState(
  state: Awaited<ReturnType<DomainKnowledgeApplication["state"]>>,
  proposalId: string,
): RefactoringTask | null {
  const task = state.nodes.get(proposalId)?.data?.task as { id?: unknown; status?: unknown } | undefined;
  return typeof task?.id === "string" && (task.status === "open" || task.status === "done")
    ? { id: task.id, status: task.status }
    : null;
}

export class RefactoringTaskService {
  private readonly domain: DomainKnowledgeApplication;

  constructor(
    private readonly port: KnowledgeProjectPort,
    private readonly sink: RefactoringTaskSink,
  ) {
    this.domain = new DomainKnowledgeApplication(port);
  }

  async issue(proposal: RefactoringProposal): Promise<RefactoringTask> {
    let state = await this.domain.state();
    const previous = taskFromState(state, proposal.proposalId);
    if (previous) return previous;

    const fingerprint = await this.port.fingerprint();
    const task = await this.sink.issue(proposal);
    const contentFingerprint = `sha256:${createHash("sha256")
      .update(canonicalJson({ proposal, task }), "utf8")
      .digest("hex")}`;
    const transactionId = `tx:refactoring-task/${createHash("sha256")
      .update(canonicalJson({ proposalId: proposal.proposalId, task }), "utf8")
      .digest("hex")}`;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeKnowledgeTransaction(this.domain.knowledgeLogPath, {
          transactionId,
          analysisSnapshotId: `analysis:${fingerprint}`,
          sourceRevisions: { code: `sha256:${fingerprint}`, spec: null, trace: null },
          origin: "human-approval",
          operations: [{
            op: "upsert-node",
            record: {
              id: proposal.proposalId,
              kind: "refactoring-proposal",
              revision: { sourceRevision: `sha256:${fingerprint}`, contentFingerprint },
              data: { proposal, task },
            },
          }],
          provenance: {
            proposalIds: [proposal.proposalId],
            approval: { kind: "human", reviewRef: null },
            generatorSchema: 1,
          },
        }, state.head);
        return task;
      } catch (error) {
        if (!(error instanceof KnowledgeHeadConflictError) || attempt > 0) throw error;
        state = await this.domain.state();
        const concurrentlyIssued = taskFromState(state, proposal.proposalId);
        if (concurrentlyIssued) return concurrentlyIssued;
      }
    }
    return task;
  }
}
