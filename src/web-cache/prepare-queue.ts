/**
 * src/web-cache/prepare-queue.ts — Background queue for web-cache prepares.
 *
 * Preparing a project's web cache runs a full analyze() + view build, which on a
 * large repo (KuzuSurvivors etc.) takes minutes. The old POST /prepare-web-cache
 * awaited the whole thing, so the browser's fetch timed out mid-build even though
 * the server kept working — leaving the user with a failure and no visibility.
 *
 * This queue decouples the trigger from the work: enqueue() records a job and
 * returns immediately; a SERIAL worker (one at a time — running two heavy
 * analyses concurrently risks the tree-sitter WASM heap, see memory) drains the
 * queue, stamping each job's phase/timestamps as it goes. The panel polls
 * jobs() to visualise the queue (state + phase + elapsed + error).
 *
 * In-memory only: the warm server is long-lived (idle-shutdown after 180min), so
 * an in-flight queue need not survive a restart. History is bounded so a
 * long-running server doesn't accumulate finished jobs forever.
 *
 * SRP: job lifecycle + serial scheduling. The actual prepare work is injected as
 * a `runner` (the route wires analyze + buildWebCacheBundle + writeWebCache), so
 * this module has no dependency on the project manager or HTTP.
 */

/** Lifecycle state of a prepare job. */
export type PrepareJobState = "queued" | "running" | "done" | "failed";

/** A summary of a completed prepare (mirrors the manifest the route persisted). */
export interface PrepareJobResult {
  views: number;
  counts: Record<string, number>;
}

/** One enqueued prepare, as surfaced to the panel. */
export interface PrepareJob {
  id: string;
  projectId: string;
  state: PrepareJobState;
  /** Current phase while running (e.g. "analyzing"), else null. */
  phase: string | null;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Error message when state === "failed", else null. */
  error: string | null;
  /** Result summary when state === "done", else null. */
  result: PrepareJobResult | null;
}

/**
 * The work a job performs. Receives a `setPhase` callback to report coarse
 * progress (analyze → build → write) the panel can show. Resolves with the
 * result summary; a throw marks the job failed.
 */
export type PrepareRunner = (
  projectId: string,
  setPhase: (phase: string) => void,
) => Promise<PrepareJobResult>;

/** How many finished (done/failed) jobs to retain for the panel's history. */
const HISTORY_LIMIT = 30;

/**
 * Serial, in-memory queue of web-cache prepare jobs.
 *
 * `enqueue` is idempotent per project while a job is still pending: a project
 * that is already queued or running returns its existing job instead of stacking
 * a duplicate analyse. Finished jobs are kept (bounded) so the panel can show
 * "done/failed" outcomes, and re-enqueuing a finished project starts a new job.
 */
export class PrepareQueue {
  private readonly runner: PrepareRunner;
  /** Insertion-ordered jobs: active (queued/running) first-in, then history. */
  private readonly jobList: PrepareJob[] = [];
  private seq = 0;
  private draining = false;
  /** Monotonic clock injected for tests; defaults to Date.now via timestamp(). */
  private readonly now: () => number;

  constructor(runner: PrepareRunner, opts: { now?: () => number } = {}) {
    this.runner = runner;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Enqueue a prepare for a project. Returns the existing job if one is already
   * queued/running for the project (dedup); otherwise creates and schedules a
   * new job. Never throws — the work runs in the background worker.
   */
  enqueue(projectId: string): PrepareJob {
    const pending = this.jobList.find(
      (j) => j.projectId === projectId && (j.state === "queued" || j.state === "running"),
    );
    if (pending) return pending;

    const job: PrepareJob = {
      id: `job-${++this.seq}-${this.now()}`,
      projectId,
      state: "queued",
      phase: null,
      enqueuedAt: this.iso(),
      startedAt: null,
      finishedAt: null,
      error: null,
      result: null,
    };
    this.jobList.push(job);
    // Start the worker on a microtask, NOT synchronously, so enqueue() returns
    // with the job still "queued" (the POST response reports queued; the worker
    // flips it to running on the next tick).
    void Promise.resolve().then(() => this.drain());
    return job;
  }

  /** A snapshot of the queue: active jobs in order, then recent history. */
  jobs(): PrepareJob[] {
    return this.jobList.map((j) => ({ ...j }));
  }

  /** Whether a worker is currently draining the queue. */
  get active(): boolean {
    return this.draining;
  }

  /**
   * Drain the queue one job at a time. Re-entrancy-guarded so concurrent
   * enqueues share a single worker. Each job is isolated: a failure marks that
   * job failed and the worker continues to the next.
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const job = this.jobList.find((j) => j.state === "queued");
        if (!job) break;
        job.state = "running";
        job.startedAt = this.iso();
        job.phase = "starting";
        try {
          job.result = await this.runner(job.projectId, (phase) => {
            // Ignore phase updates once the job has terminated (defensive).
            if (job.state === "running") job.phase = phase;
          });
          job.state = "done";
        } catch (err) {
          job.state = "failed";
          job.error = err instanceof Error ? err.message : String(err);
        } finally {
          job.phase = null;
          job.finishedAt = this.iso();
        }
        this.trimHistory();
      }
    } finally {
      this.draining = false;
    }
  }

  /** Keep the active jobs plus the most recent finished ones (bounded). */
  private trimHistory(): void {
    const finished = this.jobList.filter((j) => j.state === "done" || j.state === "failed");
    const excess = finished.length - HISTORY_LIMIT;
    if (excess <= 0) return;
    // Drop the oldest finished jobs (front of the list) to cap memory.
    let toDrop = excess;
    for (let i = 0; i < this.jobList.length && toDrop > 0; ) {
      const j = this.jobList[i]!;
      if (j.state === "done" || j.state === "failed") {
        this.jobList.splice(i, 1);
        toDrop--;
      } else {
        i++;
      }
    }
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}
