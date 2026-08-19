/**
 * src/adapters/__tests__/entrypoint-routes.test.ts
 *
 * The entry-graph HTTP surface: gated on the prepared cache (409 before
 * prepare), served whole and per-entry afterwards. The per-entry route must be a
 * FILTER of the same prepared payload — opening one entry never re-derives.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Hono } from "hono";
import { createApp } from "../web/server.js";
import { ProjectManager } from "../../project/manager.js";
import { ProjectRegistry } from "../../project/registry.js";

let home: string;
let root: string;
let app: Hono;
let pid: string;

const get = (path: string) => app.fetch(new Request(`http://localhost/api/projects/${pid}${path}`));
const post = (path: string) =>
  app.fetch(new Request(`http://localhost/api/projects/${pid}${path}`, { method: "POST" }));

async function waitForJob(jobId: string, timeoutMs = 60000): Promise<{ state: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { jobs } = (await (await app.fetch(new Request("http://localhost/api/prepare-jobs"))).json()) as {
      jobs: Array<{ id: string; state: string }>;
    };
    const job = jobs.find((candidate) => candidate.id === jobId);
    if (job && (job.state === "done" || job.state === "failed")) return job;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not finish: ${JSON.stringify(job)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "anatomia-entrypoint-home-"));
  root = await mkdtemp(join(tmpdir(), "anatomia-entrypoint-fixture-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "spec"), { recursive: true });
  // `handleUsers` is registered as a route, so it is an entry; `helper` is only
  // reachable through it; `stray` is reachable from nothing.
  await writeFile(
    join(root, "src", "routes.ts"),
    [
      "export function handleUsers() { helper(); }",
      "export function helper() { }",
      "export function stray() { }",
      'app.get("/users", handleUsers);',
      "",
    ].join("\n"),
    "utf8",
  );
  const manager = new ProjectManager(new ProjectRegistry(), { homeDir: home, analyzeOptions: { quiet: true } });
  const project = await manager.addProject({ name: "Entry", rootPath: root, knowledgeWriteRoot: join(root, "spec") });
  pid = project.id;
  app = createApp(manager);
  const sync = await app.fetch(new Request(`http://localhost/api/projects/${pid}/scenes/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmSync: true, expectedHead: null }),
  }));
  expect(sync.status, await sync.text()).toBe(200);
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

describe("entry-point HTTP surface", () => {
  it("is 409 not-prepared before the cache is prepared", async () => {
    const response = await get("/entrypoint-graph");
    expect(response.status).toBe(409);
    expect((await response.json()).view).toBe("entrypoint-view");
  });

  it("serves the whole graph after prepare, with unrooted symbols surfaced", async () => {
    const enqueued = await (await post("/prepare-web-cache")).json();
    expect((await waitForJob(enqueued.jobId)).state).toBe("done");

    const response = await get("/entrypoint-graph");
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.entries.map((entry: { symbol: { name: string } }) => entry.symbol.name)).toContain("handleUsers");
    expect(payload.entries.every((entry: { sceneIds: string[] }) => Array.isArray(entry.sceneIds))).toBe(true);
    expect(payload.unrooted.map((symbol: { name: string }) => symbol.name)).toContain("stray");
  });

  it("filters one entry's reach tree out of the same prepared payload", async () => {
    const whole = await (await get("/entrypoint-graph")).json();
    const entry = whole.entries.find((candidate: { symbol: { name: string } }) => candidate.symbol.name === "handleUsers");
    const response = await get(`/entrypoint-graph/${encodeURIComponent(entry.id)}`);
    expect(response.status).toBe(200);
    const tree = await response.json();
    expect(tree.entry.id).toBe(entry.id);
    expect(tree.nodes.map((node: { name: string }) => node.name).sort()).toEqual(["handleUsers", "helper"]);
    expect(tree.nodes.every((node: { reachedFrom: string[] }) => node.reachedFrom.includes(entry.id))).toBe(true);
  });

  it("404s an unknown entry id", async () => {
    expect((await get("/entrypoint-graph/nope")).status).toBe(404);
  });
});
