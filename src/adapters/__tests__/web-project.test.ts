/**
 * Web adapter -- project-aware tests.
 *
 * Verifies GET /api/projects + ?project= scoping when createApp is backed by a
 * ProjectManager, and that single-context mode still exposes a one-entry list.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../web/server.js";
import { ProjectManager, ProjectRegistry } from "../../project/index.js";
import { buildFromSource } from "../../supply/__tests__/helpers.js";
import type { AnalysisContext } from "../../core.js";

let home: string;
let rootA: string;
let rootB: string;
let mgr: ProjectManager;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "anatomia-web-home-"));
  rootA = await mkdtemp(join(tmpdir(), "anatomia-web-a-"));
  rootB = await mkdtemp(join(tmpdir(), "anatomia-web-b-"));
  await mkdir(join(rootA, "src"), { recursive: true });
  await mkdir(join(rootB, "src"), { recursive: true });
  await writeFile(join(rootA, "src", "a.cpp"), "void webA1() { }\nvoid webA2() { webA1(); }\nvoid webA3() { webA2(); }\n", "utf8");
  await writeFile(join(rootB, "src", "b.cpp"), "void webBOnly() { }\n", "utf8");

  mgr = new ProjectManager(new ProjectRegistry(), { homeDir: home, analyzeOptions: { quiet: true } });
  await mgr.addProject({ name: "WebA", rootPath: rootA });
  await mgr.addProject({ name: "WebB", rootPath: rootB });
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(rootA, { recursive: true, force: true });
  await rm(rootB, { recursive: true, force: true });
});

describe("manager-backed web app", () => {
  it("GET /api/projects lists the registry", async () => {
    const app = createApp(mgr);
    const res = await app.fetch(new Request("http://localhost/api/projects"));
    expect(res.status).toBe(200);
    const body = await res.json() as { projects: Array<{ id: string }>; selected: string };
    expect(body.projects.map((p) => p.id).sort()).toEqual(["weba", "webb"]);
    expect(body.selected).toBe("weba");
  });

  it("GET /api/graph?project= scopes nodes to that project", async () => {
    const app = createApp(mgr);
    const resA = await app.fetch(new Request("http://localhost/api/graph?project=weba"));
    const resB = await app.fetch(new Request("http://localhost/api/graph?project=webb"));
    const a = await resA.json() as { nodes: unknown[] };
    const b = await resB.json() as { nodes: unknown[] };
    expect(a.nodes.length).toBeGreaterThan(b.nodes.length);
  });

  it("defaults to the selected project when ?project is omitted", async () => {
    const app = createApp(mgr);
    const res = await app.fetch(new Request("http://localhost/api/graph"));
    const body = await res.json() as { nodes: Array<{ name: string }> };
    const names = body.nodes.map((n) => n.name);
    expect(names).toContain("webA1");
  });
});

describe("single-context web app (legacy)", () => {
  it("GET /api/projects returns a one-entry repo-named list", async () => {
    const { graph, file, functions } = await buildFromSource("void leg() { }\n");
    const ctx: AnalysisContext = { repoPath: "/legacy", graph, files: [file], functions };
    const app = createApp(ctx);
    const res = await app.fetch(new Request("http://localhost/api/projects"));
    const body = await res.json() as { projects: Array<{ id: string }>; selected: string };
    expect(body.projects.length).toBe(1);
    expect(body.selected).toBe("legacy");
  });
});
