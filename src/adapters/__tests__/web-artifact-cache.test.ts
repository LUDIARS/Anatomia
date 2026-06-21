/**
 * src/adapters/__tests__/web-artifact-cache.test.ts
 *
 * The hotspots / domains / review routes serve their built JSON from the
 * fingerprint-keyed disk artifact cache (same mechanism as vis-data), so a cold
 * just-restarted warm server answers without re-analysing the repo. This proves
 * the second identical request is an artifact-cache HIT (no rebuild), and that
 * each (topHotspots, maxList) review variant is cached under its own key.
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

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "anatomia-artifact-home-"));
  root = await mkdtemp(join(tmpdir(), "anatomia-artifact-fixture-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "fixture.cpp"),
    "void foo() { } void bar() { foo(); }\n",
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
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

const get = (path: string) =>
  app.fetch(new Request(`http://localhost/api/projects/${pid}${path}`));

describe.each(["hotspots", "domains"])(
  "GET /api/projects/:id/%s — disk artifact cache",
  (route) => {
    it("misses then hits the artifact cache on identical requests", async () => {
      const missBefore = mgr.cache.artifactMisses;
      const hitBefore = mgr.cache.artifactHits;

      const first = await get(`/${route}`);
      expect(first.status).toBe(200);
      // Cold artifact → one miss, no hit.
      expect(mgr.cache.artifactMisses).toBe(missBefore + 1);
      expect(mgr.cache.artifactHits).toBe(hitBefore);

      const firstBody = await first.json();
      const second = await get(`/${route}`);
      expect(second.status).toBe(200);
      // Second identical request is served from disk — a hit, no new miss.
      expect(mgr.cache.artifactHits).toBe(hitBefore + 1);
      expect(mgr.cache.artifactMisses).toBe(missBefore + 1);
      // Same payload either way.
      expect(await second.json()).toEqual(firstBody);
    });
  },
);

describe("GET /api/projects/:id/review — per-parameter disk cache", () => {
  it("caches each (topHotspots, maxList) variant under its own key", async () => {
    // Default variant.
    const m0 = mgr.cache.artifactMisses;
    const h0 = mgr.cache.artifactHits;
    expect((await get("/review")).status).toBe(200);
    expect(mgr.cache.artifactMisses).toBe(m0 + 1); // cold default → miss
    expect((await get("/review")).status).toBe(200);
    expect(mgr.cache.artifactHits).toBe(h0 + 1); // default repeat → hit

    // A parameterised variant is a distinct key: it misses on first request
    // (not served by the default's cached entry) then hits on repeat.
    const m1 = mgr.cache.artifactMisses;
    const h1 = mgr.cache.artifactHits;
    expect((await get("/review?topHotspots=5")).status).toBe(200);
    expect(mgr.cache.artifactMisses).toBe(m1 + 1); // new variant → miss
    expect((await get("/review?topHotspots=5")).status).toBe(200);
    expect(mgr.cache.artifactHits).toBe(h1 + 1); // variant repeat → hit
  });
});

describe("artifact routes — unknown project", () => {
  it.each(["/hotspots", "/domains", "/review"])(
    "returns 404 for %s on an unknown project id",
    async (path) => {
      const res = await app.fetch(
        new Request(`http://localhost/api/projects/nope${path}`),
      );
      expect(res.status).toBe(404);
    },
  );
});
