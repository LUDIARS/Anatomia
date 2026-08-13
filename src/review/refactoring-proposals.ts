// @spec リファクタリング提案生成 + 調整タスク発行 (task sink)

import { createHash } from "node:crypto";
import { canonicalJson } from "../knowledge/canonical-json.js";

export type RefactoringAction = "move" | "split-module" | "break-cycle" | "dedupe" | "layer-fix";
export type RefactoringSignalRule = "misfit" | "low-cohesion" | "layer-violation" | "cycle" | "structural-dup";

export interface RefactoringLocation { stableId: string; file: string; line: number; }
export interface RefactoringProposal {
  proposalId: string;
  rule: RefactoringSignalRule;
  action: RefactoringAction;
  targets: RefactoringLocation[];
  evidence: { metric: string; value: number; threshold: number; detail: string };
  impactRadius: { codeSymbols: number; modules: number; domains: number };
  task?: { id: string; status: "open" | "done" };
}

export interface RefactoringSignal {
  rule: RefactoringSignalRule;
  action: RefactoringAction;
  targets: RefactoringLocation[];
  evidence: RefactoringProposal["evidence"];
  impactRadius: RefactoringProposal["impactRadius"];
}

/** Stable identity deliberately excludes presentation text and all clock/random inputs. */
export function refactoringProposalId(signal: Pick<RefactoringSignal, "rule" | "action" | "targets" | "evidence">): string {
  const identity = {
    rule: signal.rule,
    action: signal.action,
    targetStableIds: [...new Set(signal.targets.map((target) => target.stableId))].sort(),
    threshold: { metric: signal.evidence.metric, threshold: signal.evidence.threshold },
  };
  return `proposal:refactor:${createHash("sha256").update(canonicalJson(identity), "utf8").digest("hex").slice(0, 24)}`;
}

export function buildRefactoringProposals(signals: readonly RefactoringSignal[]): RefactoringProposal[] {
  const candidates = signals.map((signal) => ({
    ...signal,
    targets: [...signal.targets].sort((a, b) =>
      a.stableId.localeCompare(b.stableId)
      || a.file.localeCompare(b.file)
      || a.line - b.line),
    proposalId: refactoringProposalId(signal),
  })).sort((a, b) =>
    a.proposalId.localeCompare(b.proposalId)
    || canonicalJson(a).localeCompare(canonicalJson(b)));

  return candidates.filter((proposal, index) =>
    index === 0 || proposal.proposalId !== candidates[index - 1]!.proposalId);
}
