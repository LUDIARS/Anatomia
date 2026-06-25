/**
 * Background prepare queue (src/web-cache/prepare-queue.ts).
 *
 * The queue decouples the HTTP trigger from the slow analyze/build work and runs
 * jobs serially. These tests pin: enqueue returns a job, dedup per project,
 * serial (one-at-a-time) execution, phase reporting, failure isolation, and the
 * done/failed terminal states — all without real analysis.
 */
import { describe, it, expect } from "vitest";
import { PrepareQueue } from "./prepare-queue.js";
import type { PrepareJobResult } from "./prepare-queue.js";

/** A runner whose per-project completion the test controls explicitly. */
function deferredRunner() {
  const gates = new Map<string, { resolve: (r: PrepareJobResult) => void; reject: (e: Error) => void }>();
  const phases = new Map<string, string[]>();
  const started: string[] = [];
  const runner = (projectId: string, setPhase: (p: string) => void) => {
    started.push(projectId);
    phases.set(projectId, []);
    setPhase("analyzing");
    phases.get(projectId)!.push("analyzing");
    return new Promise<PrepareJobResult>((resolve, reject) => {
      gates.set(projectId, { resolve, reject });
    });
  };
  return { runner, gates, phases, started };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("PrepareQueue", () => {
  it("enqueue returns a queued job that transitions to running then done", async () => {
    const { runner, gates } = deferredRunner();
    const q = new PrepareQueue(runner);

    const job = q.enqueue("ks");
    expect(job.projectId).toBe("ks");
    expect(job.state).toBe("queued");

    await tick(); // let the worker pick it up
    expect(q.jobs()[0].state).toBe("running");
    expect(q.jobs()[0].phase).toBe("analyzing");

    gates.get("ks")!.resolve({ views: 8, counts: { graph: 100 } });
    await tick();
    const done = q.jobs().find((j) => j.projectId === "ks")!;
    expect(done.state).toBe("done");
    expect(done.result).toEqual({ views: 8, counts: { graph: 100 } });
    expect(done.phase).toBeNull();
    expect(done.finishedAt).not.toBeNull();
  });

  it("dedups a project that is already queued/running", async () => {
    const { runner, gates, started } = deferredRunner();
    const q = new PrepareQueue(runner);

    const a = q.enqueue("ks");
    const b = q.enqueue("ks"); // running/queued → same job
    expect(b.id).toBe(a.id);
    await tick();
    const c = q.enqueue("ks"); // still running → same job
    expect(c.id).toBe(a.id);

    gates.get("ks")!.resolve({ views: 1, counts: {} });
    await tick();
    // after it finished, a fresh enqueue starts a NEW job
    const d = q.enqueue("ks");
    expect(d.id).not.toBe(a.id);
    await tick(); // let the worker pick up the new job
    expect(started.filter((p) => p === "ks").length).toBe(2);
  });

  it("runs jobs serially — the second starts only after the first finishes", async () => {
    const { runner, gates, started } = deferredRunner();
    const q = new PrepareQueue(runner);

    q.enqueue("ks");
    q.enqueue("pictor");
    await tick();
    // only the first has started; the second is still queued
    expect(started).toEqual(["ks"]);
    expect(q.jobs().find((j) => j.projectId === "pictor")!.state).toBe("queued");

    gates.get("ks")!.resolve({ views: 8, counts: {} });
    await tick();
    expect(started).toEqual(["ks", "pictor"]);
    expect(q.jobs().find((j) => j.projectId === "pictor")!.state).toBe("running");

    gates.get("pictor")!.resolve({ views: 8, counts: {} });
    await tick();
    expect(q.jobs().filter((j) => j.state === "done").length).toBe(2);
  });

  it("isolates a failing job and keeps draining", async () => {
    const { runner, gates } = deferredRunner();
    const q = new PrepareQueue(runner);

    q.enqueue("ks");
    q.enqueue("pictor");
    await tick();
    gates.get("ks")!.reject(new Error("WASM heap exhausted"));
    await tick();

    const ksJob = q.jobs().find((j) => j.projectId === "ks")!;
    expect(ksJob.state).toBe("failed");
    expect(ksJob.error).toMatch(/WASM heap/);

    // the worker moved on to the next job despite the failure
    expect(q.jobs().find((j) => j.projectId === "pictor")!.state).toBe("running");
    gates.get("pictor")!.resolve({ views: 8, counts: {} });
    await tick();
    expect(q.jobs().find((j) => j.projectId === "pictor")!.state).toBe("done");
  });
});
