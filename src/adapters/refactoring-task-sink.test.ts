import { describe, expect, it, vi } from "vitest";
import { buildRefactoringProposals } from "../review/refactoring-proposals.js";
import {
  configuredRefactoringTaskSink,
  HttpRefactoringTaskSink,
} from "./refactoring-task-sink.js";

const proposal = buildRefactoringProposals([{
  rule: "misfit",
  action: "move",
  targets: [{ stableId: "fn:a", file: "src/a.ts", line: 3 }],
  evidence: { metric: "ties", value: 3, threshold: 1, detail: "a" },
  impactRadius: { codeSymbols: 1, modules: 2, domains: 0 },
}])[0]!;

describe("HTTP refactoring task sink", () => {
  it("sends the proposal id as an idempotency key and refuses redirects", async () => {
    const fetcher = vi.fn(async (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ) => new Response(
      JSON.stringify({ id: " task-1 ", status: "open" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const sink = new HttpRefactoringTaskSink(
      "https://tasks.example.test/workflow",
      fetcher as unknown as typeof fetch,
    );

    await expect(sink.issue(proposal)).resolves.toEqual({ id: "task-1", status: "open" });
    const [, init] = fetcher.mock.calls[0]!;
    expect(new Headers(init?.headers).get("idempotency-key")).toBe(proposal.proposalId);
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails fast for an unknown sink kind or unsafe endpoint", () => {
    expect(() => configuredRefactoringTaskSink({
      ANATOMIA_REFACTORING_TASK_SINK: "typo",
      MEMORIA_TASK_URL: "https://tasks.example.test",
    })).toThrow(/must be memoria or cc/);
    expect(() => configuredRefactoringTaskSink({
      ANATOMIA_REFACTORING_TASK_SINK: "memoria",
      MEMORIA_TASK_URL: "file:///tmp/tasks",
    })).toThrow(/HTTP\(S\)/);
    expect(() => configuredRefactoringTaskSink({
      ANATOMIA_REFACTORING_TASK_SINK: "memoria",
      MEMORIA_TASK_URL: "https://user@tasks.example.test/workflow",
    })).toThrow(/without credentials/);
  });
});
