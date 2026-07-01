/**
 * Serial background queue for project analysis jobs.
 *
 * A full analyze() can take minutes on large repositories. The web API uses
 * this queue so POST /api/projects/:id/analyze returns immediately and the UI
 * can poll job state instead of holding a long HTTP request open.
 */

export type AnalysisJobState = "queued" | "running" | "done" | "failed";

export interface AnalysisJobResult {
  files: number;
  functions: number;
}

export interface AnalysisJob {
  id: string;
  projectId: string;
  state: AnalysisJobState;
  phase: string | null;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  result: AnalysisJobResult | null;
}

export type AnalysisRunner = (
  projectId: string,
  setPhase: (phase: string) => void,
) => Promise<AnalysisJobResult>;

const HISTORY_LIMIT = 30;

export class AnalysisQueue {
  private readonly runner: AnalysisRunner;
  private readonly jobList: AnalysisJob[] = [];
  private readonly now: () => number;
  private seq = 0;
  private draining = false;

  constructor(runner: AnalysisRunner, opts: { now?: () => number } = {}) {
    this.runner = runner;
    this.now = opts.now ?? (() => Date.now());
  }

  enqueue(projectId: string): AnalysisJob {
    const pending = this.jobList.find(
      (j) => j.projectId === projectId && (j.state === "queued" || j.state === "running"),
    );
    if (pending) return { ...pending };

    const job: AnalysisJob = {
      id: `analysis-${++this.seq}-${this.now()}`,
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
    void Promise.resolve().then(() => this.drain());
    return { ...job };
  }

  jobs(): AnalysisJob[] {
    return this.jobList.map((j) => ({ ...j }));
  }

  get active(): boolean {
    return this.draining;
  }

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
            if (job.state === "running") job.phase = phase;
          });
          job.state = "done";
        } catch (err) {
          job.state = "failed";
          job.error = err instanceof Error ? err.message : String(err);
        } finally {
          job.phase = null;
          job.finishedAt = this.iso();
          this.trimHistory();
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private trimHistory(): void {
    const finished = this.jobList.filter((j) => j.state === "done" || j.state === "failed");
    let excess = finished.length - HISTORY_LIMIT;
    for (let i = 0; i < this.jobList.length && excess > 0;) {
      const job = this.jobList[i]!;
      if (job.state === "done" || job.state === "failed") {
        this.jobList.splice(i, 1);
        excess--;
      } else {
        i++;
      }
    }
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}
