/**
 * Web adapter — branch-diff + domain-view route wiring.
 *
 * The view-assembly logic is unit-tested in domains/view.test.ts and
 * branch/diff.test.ts; here we assert the HTTP routes are mounted, resolve a
 * project, shape JSON, and 404 on unknown ids. The temp project roots are not
 * git repos, so branch-diff degrades to available:false (not an error).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../web/server.js";
import { ProjectManager, ProjectRegistry } from "../../project/index.js";

let home: string;
let root: string;
let mgr: ProjectManager;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "anatomia-views-home-"));
  root = await mkdtemp(join(tmpdir(), "anatomia-views-root-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "a.cpp"),
    "void one() { }\nvoid two() { one(); }\n",
    "utf8",
  );
  mgr = new ProjectManager(new ProjectRegistry(), {
    homeDir: home,
    analyzeOptions: { quiet: true },
  });
  await mgr.addProject({ name: "Views", rootPath: root });
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

describe("GET /api/projects/:id/domain-view", () => {
  it("returns the enriched payload (views + module breakdown) for a known project", async () => {
    const app = createApp(mgr);
    const res = await app.fetch(
      new Request("http://localhost/api/projects/views/domain-view"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // The route now returns { views, modulesByDomain, modularity, granularity, misfits }
    // (the 機能/module layer added for the right-pane list), not a bare array.
    expect(Array.isArray(body.views)).toBe(true);
    expect(typeof body.modulesByDomain).toBe("object");
    expect(typeof body.modularity).toBe("number");
  });

  it("404s on an unknown project", async () => {
    const app = createApp(mgr);
    const res = await app.fetch(
      new Request("http://localhost/api/projects/nope/domain-view"),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/projects/:id/modules", () => {
  it("returns the module evaluation for a known project", async () => {
    const app = createApp(mgr);
    const res = await app.fetch(
      new Request("http://localhost/api/projects/views/modules"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      modules: unknown[];
      cohesion: unknown[];
      modularity: number;
      granularity: string;
    };
    expect(Array.isArray(body.modules)).toBe(true);
    expect(typeof body.modularity).toBe("number");
    expect(body.granularity).toBe("dir");
  });

  it("404s on an unknown project", async () => {
    const app = createApp(mgr);
    const res = await app.fetch(new Request("http://localhost/api/projects/nope/modules"));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/integral", () => {
  it("runs a deterministic search (no judge) for a known project", async () => {
    const app = createApp(mgr);
    const res = await app.fetch(
      new Request("http://localhost/api/integral", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: "views",
          entry: { ref: "two", scope: "function" },
          range: { climb: "module" },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { seeds: string[] }; decision: unknown; cached: boolean };
    expect(body.result.seeds.length).toBeGreaterThan(0);
    expect(body.decision).toBeNull(); // judge not requested → deterministic only
  });

  it("400s on a missing entry", async () => {
    const app = createApp(mgr);
    const res = await app.fetch(
      new Request("http://localhost/api/integral", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: "views" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/projects/:id/branch-diff", () => {
  it("degrades to available:false outside a git repo", async () => {
    const app = createApp(mgr);
    const res = await app.fetch(
      new Request("http://localhost/api/projects/views/branch-diff"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; reason?: string };
    expect(body.available).toBe(false);
    expect(body.reason).toMatch(/not a git repository/);
  });

  it("404s on an unknown project", async () => {
    const app = createApp(mgr);
    const res = await app.fetch(
      new Request("http://localhost/api/projects/nope/branch-diff"),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/projects/:id/branches", () => {
  it("returns the base-selector shape (empty candidates outside a git repo)", async () => {
    const app = createApp(mgr);
    const res = await app.fetch(
      new Request("http://localhost/api/projects/views/branches"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      current: string | null;
      autoBase: string | null;
      candidates: string[];
    };
    expect(Array.isArray(body.candidates)).toBe(true);
    expect(body.candidates).toHaveLength(0);
    expect(body.autoBase).toBeNull();
  });

  it("404s on an unknown project", async () => {
    const app = createApp(mgr);
    const res = await app.fetch(
      new Request("http://localhost/api/projects/nope/branches"),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/projects/:id/access-patterns", () => {
  it("returns an array for a known project", async () => {
    const app = createApp(mgr);
    const res = await app.fetch(
      new Request("http://localhost/api/projects/views/access-patterns"),
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("404s on an unknown project", async () => {
    const app = createApp(mgr);
    const res = await app.fetch(
      new Request("http://localhost/api/projects/nope/access-patterns"),
    );
    expect(res.status).toBe(404);
  });
});
