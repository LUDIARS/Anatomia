import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { buildRefactoringProposals } from "../review/refactoring-proposals.js";
import { RefactoringTaskService } from "./refactoring-tasks.js";

describe("refactoring proposals and task issuance", () => {
  it("derives the same proposal id regardless of target order and presentation text", () => {
    const signal = { rule: "misfit" as const, action: "move" as const, targets: [{ stableId: "fn:a", file: "a.ts", line: 3 }], evidence: { metric: "ties", value: 3, threshold: 1, detail: "a" }, impactRadius: { codeSymbols: 1, modules: 2, domains: 0 } };
    const changedPresentation = {
      ...signal,
      targets: [
        { stableId: "fn:b", file: "moved/b.ts", line: 20 },
        { stableId: "fn:a", file: "moved/a.ts", line: 10 },
      ],
      evidence: { ...signal.evidence, value: 99, detail: "updated presentation" },
    };
    const reversed = {
      ...changedPresentation,
      targets: [...changedPresentation.targets].reverse(),
      evidence: { ...changedPresentation.evidence, value: 4, detail: "another rendering" },
    };
    expect(buildRefactoringProposals([changedPresentation])[0]!.proposalId)
      .toBe(buildRefactoringProposals([reversed])[0]!.proposalId);
  });

  it("uses proposalId as an idempotency key after issuing once", async () => {
    const root = await mkdtemp(join(tmpdir(), "refactoring-tasks-"));
    await mkdir(join(root, "spec"));
    const sink = { issue: vi.fn(async () => ({ id: "task-1", status: "open" as const })) };
    const port = { project: { id: "demo", name: "demo", rootPath: root, addedAt: "2026-08-13T00:00:00.000Z" }, context: async () => ({} as never), refresh: async () => ({} as never), fingerprint: async () => "fingerprint" };
    const proposal = buildRefactoringProposals([{ rule: "misfit", action: "move", targets: [{ stableId: "fn:a", file: "a.ts", line: 3 }], evidence: { metric: "ties", value: 3, threshold: 1, detail: "a" }, impactRadius: { codeSymbols: 1, modules: 2, domains: 0 } }])[0]!;
    const service = new RefactoringTaskService(port, sink);
    await expect(service.issue(proposal)).resolves.toEqual({ id: "task-1", status: "open" });
    await expect(service.issue(proposal)).resolves.toEqual({ id: "task-1", status: "open" });
    expect(sink.issue).toHaveBeenCalledTimes(1);
    await rm(root, { recursive: true, force: true });
  });
});
