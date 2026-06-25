/**
 * src/adapters/__tests__/web-cache-routes.test.ts
 *
 * End-to-end for the prepared web-display cache + adjustment routes:
 *   - a view is 409 (not-prepared) until prepare-web-cache builds the bundle;
 *   - prepare then serves every view + a fresh (non-stale) manifest;
 *   - search/retune fail FAST (501) with only the stub LLM — no silent fallback;
 *   - domain/module/scene adjustments mutate the taxonomy + scenes on disk.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
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
  // Force the offline stub backend so the LLM-gated routes (search / retune) hit
  // their fail-fast guard deterministically — without a key the backend would
  // otherwise infer to the real claude-cli (subscription) and try to run it.
  priorBackend = process.env["ANATOMIA_LLM_BACKEND"];
  process.env["ANATOMIA_LLM_BACKEND"] = "stub";
  home = await mkdtemp(join(tmpdir(), "anatomia-webcache-home-"));
  root = await mkdtemp(join(tmpdir(), "anatomia-webcache-fixture-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "a.ts"),
    "export function foo() { bar(); }\nfunction bar() { }\n",
    "utf8",
  );
  mgr = new ProjectManager(new ProjectRegistry(), {
    homeDir: home,
    analyzeOptions: { quiet: true },
  });
  const p = await mgr.addProject({ name: "Fixture", rootPath: root });
  pid = p.id;
  app = createApp(mgr);
});

afterAll(async () => {
  if (priorBackend === undefined) delete process.env["ANATOMIA_LLM_BACKEND"];
  else process.env["ANATOMIA_LLM_BACKEND"] = priorBackend;
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

const get = (path: string) =>
  app.fetch(new Request(`http://localhost/api/projects/${pid}${path}`));
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

  it("prepare-web-cache builds every view + a fresh manifest", async () => {
    const res = await post("/prepare-web-cache");
    expect(res.status).toBe(200);
    const manifest = await res.json();
    expect(manifest.views).toEqual(
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
    expect(typeof manifest.preparedAt).toBe("string");

    const man = await (await get("/web/manifest")).json();
    expect(man.prepared).toBe(true);
    expect(man.stale).toBe(false); // source unchanged since prepare
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
    // scene-modules shape: domain-centred, hasScenes flag present.
    const sm = (await (await get("/web/scene-modules")).json()).data;
    expect(typeof sm.hasScenes).toBe("boolean");
    expect(Array.isArray(sm.domains)).toBe(true);
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

describe("adjustment: domain / module / scene CRUD", () => {
  it("adds a domain + module and reflects them in the model", async () => {
    const d = await post("/adjust/domain", { action: "add", name: "Combat", description: "戦闘" });
    expect(d.status).toBe(200);
    expect((await d.json()).taxonomy.domains.some((x: { name: string }) => x.name === "combat")).toBe(true);

    const m = await post("/adjust/module", {
      action: "add",
      domain: "combat",
      name: "Spawner",
      path: "src",
    });
    expect(m.status).toBe(200);

    const model = await (await get("/adjust/model")).json();
    const combat = model.taxonomy.domains.find((x: { name: string }) => x.name === "combat");
    expect(combat.modules.some((x: { name: string }) => x.name === "spawner")).toBe(true);

    // The taxonomy file was written under the repo (spec adjusted automatically).
    const tax = JSON.parse(
      await readFile(join(root, "spec", "data", "Fixture.taxonomy.json"), "utf8"),
    );
    expect(tax.domains.some((x: { name: string }) => x.name === "combat")).toBe(true);
  });

  it("renames then deletes a module", async () => {
    await post("/adjust/module", { action: "rename", domain: "combat", name: "Spawner", newName: "Waves" });
    let model = await (await get("/adjust/model")).json();
    let combat = model.taxonomy.domains.find((x: { name: string }) => x.name === "combat");
    expect(combat.modules.some((x: { name: string }) => x.name === "waves")).toBe(true);

    await post("/adjust/module", { action: "delete", domain: "combat", name: "Waves" });
    model = await (await get("/adjust/model")).json();
    combat = model.taxonomy.domains.find((x: { name: string }) => x.name === "combat");
    expect(combat.modules.some((x: { name: string }) => x.name === "waves")).toBe(false);
  });

  it("adds + deletes a manual scene", async () => {
    const add = await post("/adjust/scene", { action: "add", id: "boss", label: "Boss", domains: ["combat"] });
    expect(add.status).toBe(200);
    expect((await add.json()).scenes.some((s: { id: string }) => s.id === "boss")).toBe(true);

    const del = await post("/adjust/scene", { action: "delete", id: "boss" });
    expect(del.status).toBe(200);
    expect((await del.json()).scenes.some((s: { id: string }) => s.id === "boss")).toBe(false);
  });

  it("rejects an invalid domain action (400)", async () => {
    const res = await post("/adjust/domain", { action: "frobnicate", name: "x" });
    expect(res.status).toBe(400);
  });

  it("retune fails fast (501) on the stub LLM — no silent no-op", async () => {
    const res = await post("/adjust/retune", {});
    expect(res.status).toBe(501);
    expect((await res.json()).error).toMatch(/real LLM|API key/i);
  });
});
