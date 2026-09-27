/**
 * MCP adapter -- project-aware tests.
 *
 * Verifies the new project tools (list / add / analyze) and that the existing
 * tools accept an optional `project` arg, when the server is backed by a
 * ProjectManager.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHandlers } from "../mcp.js";
import { ProjectManager, ProjectRegistry } from "../../project/index.js";
import { writeDomainLocator } from "../../web-cache/domain-locator-store.js";

let home: string;
let rootA: string;
let rootB: string;
let mgr: ProjectManager;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "anatomia-mcp-home-"));
  rootA = await mkdtemp(join(tmpdir(), "anatomia-mcp-a-"));
  rootB = await mkdtemp(join(tmpdir(), "anatomia-mcp-b-"));
  await mkdir(join(rootA, "src"), { recursive: true });
  await mkdir(join(rootB, "src"), { recursive: true });
  await writeFile(join(rootA, "src", "a.cpp"), "void aOne() { }\nvoid aTwo() { aOne(); }\n", "utf8");
  await writeFile(join(rootB, "src", "b.cpp"), "void bOnly() { }\n", "utf8");

  mgr = new ProjectManager(new ProjectRegistry(), { homeDir: home, analyzeOptions: { quiet: true } });
  await mgr.addProject({ name: "ProjA", rootPath: rootA });
  await mgr.addProject({ name: "ProjB", rootPath: rootB });
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(rootA, { recursive: true, force: true });
  await rm(rootB, { recursive: true, force: true });
});

describe("anatomia.projects.* tools", () => {
  it("lists registered projects + selected id", async () => {
    const h = createHandlers(mgr);
    const { projects, selected } = await h["anatomia.projects.list"]();
    expect(projects.map((p) => p.id).sort()).toEqual(["proja", "projb"]);
    expect(selected).toBe("proja");
  });

  it("adds a project via the tool", async () => {
    const h = createHandlers(mgr);
    const { project } = await h["anatomia.projects.add"]({ name: "Added", rootPath: rootB });
    expect(project.id).toBe("added");
    expect(mgr.get("added")).toBeDefined();
  });

  it("analyzes a project and reports counts", async () => {
    const h = createHandlers(mgr);
    const res = await h["anatomia.projects.analyze"]({ project: "proja" });
    expect(res.project).toBe("proja");
    expect(res.functions).toBeGreaterThan(0);
  });
});

describe("existing tools take a project arg", () => {
  it("context targets the named project", async () => {
    const h = createHandlers(mgr);
    const bundle = await h["anatomia.context"]({ task: "x", project: "projb" });
    // ProjB has exactly one function (bOnly) -> at most one exemplar.
    expect(bundle.exemplars.length).toBeLessThanOrEqual(1);
  });

  it("defaults to the selected project when project arg omitted", async () => {
    const h = createHandlers(mgr);
    const bundle = await h["anatomia.context"]({ task: "x" });
    // ProjA (selected) has two functions -> exemplars present.
    expect(bundle.exemplars.length).toBeGreaterThanOrEqual(1);
  });

  it("impact resolves anchors for the named project", async () => {
    const h = createHandlers(mgr);
    const ctx = await mgr.getContext("proja");
    const nodes = await ctx.graph.allNodes();
    const res = await h["anatomia.impact"]({ anchor: nodes[0].id, project: "proja" });
    expect(Array.isArray(res.anchors)).toBe(true);
  });
});

describe("prepared map tools", () => {
  it("reads a cold manager's prepared data without analysis or fingerprinting", async () => {
    await writeDomainLocator(mgr.cache.dirFor("proja"), "proja", "prepared-fingerprint", "prepared-time", {
      domains: [{ id: "business:orders", layer: "business", name: "Orders", functionCount: 1,
        functions: [{ anchor: "anchor-1", name: "place", path: "src/a.cpp", line: 0, comment: null, specRefs: [] }] }],
    });
    const cold = new ProjectManager(mgr.registry, { homeDir: home, analyzeOptions: { quiet: true } });
    const analyze = vi.spyOn(cold, "getContext").mockRejectedValue(new Error("analysis must not run"));
    const fingerprint = vi.spyOn(cold, "fingerprint").mockRejectedValue(new Error("fingerprint must not run"));
    try {
      const h = createHandlers(cold);
      expect((await h["anatomia.map.domains"]({ project: "proja" }) as { domains: unknown[] }).domains).toHaveLength(1);
      expect((await h["anatomia.map.functions"]({ project: "proja", domainId: "business:orders" }) as { total: number }).total).toBe(1);
      expect((await h["anatomia.map.function"]({ project: "proja", anchor: "anchor-1" }) as { domains: unknown[] }).domains).toHaveLength(1);
      expect(analyze).not.toHaveBeenCalled();
      expect(fingerprint).not.toHaveBeenCalled();
    } finally { analyze.mockRestore(); fingerprint.mockRestore(); }
  });
});
