/**
 * src/adapters/__tests__/web-cache-routes.test.ts
 *
 * End-to-end for the prepared web-display cache + adjustment routes:
 *   - a view is 409 (not-prepared) until prepare-web-cache builds the bundle;
 *   - prepare then serves every view + a fresh (non-stale) manifest;
 *   - LLM search fails fast (501) with only the stub LLM — no silent fallback;
 *   - legacy reads remain available while all legacy direct writes stay removed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../web/server.js";
import { ProjectManager } from "../../project/manager.js";
import { ProjectRegistry } from "../../project/registry.js";
import type { Hono } from "hono";

let home: string;
let root: string;
let mgr: ProjectManager;
let app: Hono;
let pid: string;
let priorBackend: string | undefined;

beforeAll(async () => {
  // Force the offline stub backend so the LLM-gated search route hits
  // their fail-fast guard deterministically — without a key the backend would
  // otherwise infer to the real claude-cli (subscription) and try to run it.
  priorBackend = process.env["ANATOMIA_LLM_BACKEND"];
  process.env["ANATOMIA_LLM_BACKEND"] = "stub";
  home = await mkdtemp(join(tmpdir(), "anatomia-webcache-home-"));
  root = await mkdtemp(join(tmpdir(), "anatomia-webcache-fixture-"));
  await mkdir(join(root, "src"), { recursive: true });
  const knowledgeWriteRoot = join(root, "spec");
  await mkdir(knowledgeWriteRoot, { recursive: true });
  await writeFile(
    join(root, "src", "a.ts"),
    "export function foo() { bar(); }\nfunction bar() { }\n",
    "utf8",
  );
  mgr = new ProjectManager(new ProjectRegistry(), {
    homeDir: home,
    analyzeOptions: { quiet: true },
  });
  const p = await mgr.addProject({ name: "Fixture", rootPath: root, knowledgeWriteRoot });
  pid = p.id;
  app = createApp(mgr);
  const sync = await post("/scenes/sync", { confirmSync: true, expectedHead: null });
  expect(sync.status, await sync.text()).toBe(200);
});

afterAll(async () => {
  if (priorBackend === undefined) delete process.env["ANATOMIA_LLM_BACKEND"];
  else process.env["ANATOMIA_LLM_BACKEND"] = priorBackend;
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

const get = (path: string) =>
  app.fetch(new Request(`http://localhost/api/projects/${pid}${path}`));
const jobsSnapshot = () => app.fetch(new Request("http://localhost/api/prepare-jobs"));

/** Poll the prepare queue until the given job reaches a terminal state. */
async function waitForJob(jobId: string, timeoutMs = 30000): Promise<{ state: string; result: { views: number } }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { jobs } = (await (await jobsSnapshot()).json()) as {
      jobs: Array<{ id: string; state: string; result: { views: number } }>;
    };
    const job = jobs.find((j) => j.id === jobId);
    if (job && (job.state === "done" || job.state === "failed")) return job;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not finish: ${JSON.stringify(job)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const post = (path: string, body?: unknown) =>
  app.fetch(
    new Request(`http://localhost/api/projects/${pid}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

describe("prepared web cache: gate → prepare → serve", () => {
  it("serves 409 not-prepared before prepare", async () => {
    expect((await get("/web/manifest")).status).toBe(200);
    expect(await (await get("/web/manifest")).json()).toEqual({ prepared: false });

    const graph = await get("/web/graph");
    expect(graph.status).toBe(409);
    expect((await graph.json()).error).toBe("not-prepared");
  });

  it("prepare-web-cache enqueues a background job that builds every view", async () => {
    // Async now: POST returns 202 + a jobId; a serial worker does the build.
    const res = await post("/prepare-web-cache");
    expect(res.status).toBe(202);
    const enq = await res.json();
    expect(typeof enq.jobId).toBe("string");
    expect(enq.state).toBe("queued");

    const job = await waitForJob(enq.jobId);
    expect(job.state, JSON.stringify(job)).toBe("done");
    expect(job.result.views).toBeGreaterThanOrEqual(8);

    // The job is visible in the queue snapshot for the panel's progress widget.
    const snap = await (await jobsSnapshot()).json();
    expect(snap.jobs.some((j: { id: string }) => j.id === enq.jobId)).toBe(true);

    // After the worker finishes, the manifest is prepared + fresh.
    const man = await (await get("/web/manifest")).json();
    expect(man.prepared).toBe(true);
    expect(man.stale).toBe(false); // source unchanged since prepare
    expect(man.views).toEqual(
      expect.arrayContaining([
        "graph",
        "domain-view",
        "access-patterns",
        "hotspots",
        "spec-links",
        "domains",
        "scene-modules",
        "search-corpus",
      ]),
    );
  });

  it("serves each view envelope with its preparedAt", async () => {
    for (const view of ["graph", "domain-view", "access-patterns", "hotspots", "spec-links", "domains", "scene-modules"]) {
      const res = await get(`/web/${view}`);
      expect(res.status, view).toBe(200);
      const body = await res.json();
      expect(body.view, view).toBe(view);
      expect(typeof body.preparedAt, view).toBe("string");
      expect(body.data, view).toBeDefined();
    }
    // scene-modules shape: scene-centred, hasScenes flag present.
    const sm = (await (await get("/web/scene-modules")).json()).data;
    expect(typeof sm.hasScenes).toBe("boolean");
    expect(Array.isArray(sm.scenes)).toBe(true);
  });

  it("rejects an unknown view", async () => {
    expect((await get("/web/bogus")).status).toBe(404);
  });

  it("404s an unknown project", async () => {
    const res = await app.fetch(new Request("http://localhost/api/projects/nope/web/manifest"));
    expect(res.status).toBe(404);
  });

  it("search fails fast (501) on the stub LLM — no silent fallback", async () => {
    const res = await post("/web/search", { query: "where is foo" });
    expect(res.status).toBe(501);
    expect((await res.json()).error).toMatch(/real LLM|API key/i);
  });
});

describe("adjustment: retained read model and removed direct writes", () => {
  it("serves the retained taxonomy as a read-only migration source", async () => {
    const res = await get("/adjust/model");
    expect(res.status).toBe(200);
    const model = await res.json();
    expect(model.taxonomy).toBeDefined();
    expect(model.authoritativeWrites).toBe("knowledge-gates");
  });

  it.each(["domain", "module", "scene", "domain-organization", "retune"])(
    "rejects the removed %s direct-write route",
    async (route) => {
      const res = await post(`/adjust/${route}`, {});
      expect(res.status).toBe(410);
      expect((await res.json()).error).toMatch(/legacy direct write was removed/i);
    },
  );
});
