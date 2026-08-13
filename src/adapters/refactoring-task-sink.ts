// @spec リファクタリング提案生成 + 調整タスク発行 (task sink)

import type {
  RefactoringTask,
  RefactoringTaskSink,
} from "../knowledge/refactoring-tasks.js";
import type { RefactoringProposal } from "../review/refactoring-proposals.js";

const TASK_ID_MAX_LENGTH = 256;
const TASK_SINK_TIMEOUT_MS = 30_000;

export class HttpRefactoringTaskSink implements RefactoringTaskSink {
  constructor(
    private readonly endpoint: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async issue(proposal: RefactoringProposal): Promise<RefactoringTask> {
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": proposal.proposalId,
      },
      body: JSON.stringify({ proposalId: proposal.proposalId, proposal }),
      // A redirect could forward repository-derived proposal data to a host
      // other than the explicitly configured task service.
      redirect: "error",
      signal: AbortSignal.timeout(TASK_SINK_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`task sink failed: ${response.status}`);

    const body = await response.json() as { id?: unknown; status?: unknown };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (
      id.length === 0
      || id.length > TASK_ID_MAX_LENGTH
      || (body.status !== "open" && body.status !== "done")
    ) {
      throw new Error("task sink returned invalid task");
    }
    return { id, status: body.status };
  }
}

export function configuredRefactoringTaskSink(
  env: NodeJS.ProcessEnv = process.env,
): RefactoringTaskSink {
  const kind = (env.ANATOMIA_REFACTORING_TASK_SINK ?? "memoria").trim();
  if (kind !== "memoria" && kind !== "cc") {
    throw new Error("ANATOMIA_REFACTORING_TASK_SINK must be memoria or cc");
  }

  const variable = kind === "cc" ? "CONCORDIA_TASK_WORKFLOW_URL" : "MEMORIA_TASK_URL";
  const endpoint = env[variable]?.trim();
  if (!endpoint) throw new Error(`${variable} is required for refactoring task issuance`);

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`${variable} must be an absolute HTTP(S) URL`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.hash !== ""
  ) {
    throw new Error(`${variable} must be an HTTP(S) URL without credentials or a fragment`);
  }
  return new HttpRefactoringTaskSink(parsed.href);
}
