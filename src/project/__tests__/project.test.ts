/**
 * src/project/__tests__/project.test.ts -- Multi-project support tests.
 *
 * Covers: registry CRUD + deterministic ids, persistence round-trip across a
 * fresh registry, manager analyzing TWO different real projects (the repo's own
 * src/ and a small temp fixture), querying each separately, and the incremental
 * cache skipping work when a project is re-analyzed unchanged.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { ProjectRegistry, deriveId, slug } from "../registry.js";
import { loadRegistry, saveRegistry, ProjectManager } from "../index.js";

// Resolve the repo's own src/ dir (this file lives in src/project/__tests__).
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_SRC = join(__dirname, "..", "..");

let home: string;
let fixtureRoot: string;

const FIXTURE_CPP = `
void fixtureAlpha() { }
void fixtureBeta()  { fixtureAlpha(); }
`;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "anatomia-proj-home-"));
  fixtureRoot = await mkdtemp(join(tmpdir(), "anatomia-proj-fixture-"));
  await mkdir(join(fixtureRoot, "src"), { recursive: true });
  await writeFile(join(fixtureRoot, "src", "fixture.cpp"), FIXTURE_CPP, "utf8");
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(fixtureRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("ProjectRegistry", () => {
  it("derives a deterministic slug id from the name", () => {
    expect(slug("Kuzu Survivors")).toBe("kuzu-survivors");
    expect(deriveId({ name: "Kuzu Survivors", rootPath: "/a" })).toBe("kuzu-survivors");
  });

  it("registers, gets, lists and removes projects", () => {
    const reg = new ProjectRegistry();
    const a = reg.add({ name: "Alpha", rootPath: "/a" });
    const b = reg.add({ name: "Beta", rootPath: "/b" });
    expect(a.id).toBe("alpha");
    expect(b.id).toBe("beta");
    expect(reg.list().map((p) => p.id)).toEqual(["alpha", "beta"]);
    expect(reg.get("alpha")?.rootPath).toBe("/a");
    expect(reg.selected).toBe("alpha"); // first registered is default
    expect(reg.remove("alpha")).toBe(true);
    expect(reg.get("alpha")).toBeUndefined();
    expect(reg.selected).toBe("beta"); // selection follows removal
  });

  it("disambiguates same-name projects rooted at different paths", () => {
    const reg = new ProjectRegistry();
    const a = reg.add({ name: "Dup", rootPath: "/one" });
    const b = reg.add({ name: "Dup", rootPath: "/two" });
    expect(a.id).toBe("dup");
    expect(b.id).not.toBe("dup");
    expect(reg.list().length).toBe(2);
  });

  it("re-registering same id+path is idempotent and keeps addedAt", () => {
    const reg = new ProjectRegistry();
    const a = reg.add({ name: "X", rootPath: "/x" });
    const a2 = reg.add({ name: "X", rootPath: "/x" });
    expect(a2.id).toBe(a.id);
    expect(a2.addedAt).toBe(a.addedAt);
    expect(reg.list().length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Persistence round-trip
// ---------------------------------------------------------------------------

describe("persistence round-trip", () => {
  it("saves and reloads the registry across a fresh registry instance", async () => {
    const reg = new ProjectRegistry();
    reg.add({ name: "Repo", rootPath: REPO_SRC });
    reg.add({ name: "Fixture", rootPath: fixtureRoot });
    reg.select("fixture");
    const path = await saveRegistry(reg, home);
    expect(path).toContain("projects.json");

    const reloaded = await loadRegistry(home);
    expect(reloaded.list().map((p) => p.id).sort()).toEqual(["fixture", "repo"]);
    expect(reloaded.get("repo")?.rootPath).toBe(REPO_SRC);
    expect(reloaded.selected).toBe("fixture");
  });

  it("returns an empty registry when projects.json is absent", async () => {
    const empty = await loadRegistry(join(home, "does-not-exist"));
    expect(empty.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Manager: analyze TWO projects, query each, cache reuse
// ---------------------------------------------------------------------------

describe("ProjectManager analyzing two projects", () => {
  let mgr: ProjectManager;

  beforeAll(async () => {
    mgr = new ProjectManager(new ProjectRegistry(), {
      homeDir: home,
      analyzeOptions: { quiet: true },
    });
    await mgr.addProject({ name: "RepoSrc", rootPath: REPO_SRC });
    await mgr.addProject({ name: "Fixture", rootPath: fixtureRoot });
  });

  it("analyzes the repo's own src/ as one project", async () => {
    const ctx = await mgr.analyzeProject("reposrc");
    expect(ctx.repoPath).toBe(REPO_SRC);
    expect(ctx.functions.length).toBeGreaterThan(20);
  });

  it("analyzes the temp C++ fixture as a separate project", async () => {
    const ctx = await mgr.analyzeProject("fixture");
    expect(ctx.repoPath).toBe(fixtureRoot);
    const names = ctx.functions.map((f) => f.name);
    expect(names).toContain("fixtureAlpha");
    expect(names).toContain("fixtureBeta");
    expect(ctx.functions.length).toBeLessThan(10);
  });

  it("queries each project separately without cross-contamination", async () => {
    const repo = await mgr.getContext("reposrc");
    const fixture = await mgr.getContext("fixture");
    const repoNames = new Set(repo.functions.map((f) => f.name));
    const fixtureNames = new Set(fixture.functions.map((f) => f.name));
    expect(fixtureNames.has("fixtureAlpha")).toBe(true);
    expect(repoNames.has("fixtureAlpha")).toBe(false);
    expect(repo.functions.length).not.toBe(fixture.functions.length);
  });

  it("reuses the cache when re-analyzing an unchanged project (work skipped)", async () => {
    mgr.cache.invalidate("fixture");
    const missBefore = mgr.cache.misses;
    const a = await mgr.analyzeProject("fixture"); // miss -> real analyze
    expect(mgr.cache.misses).toBe(missBefore + 1);

    const hitBefore = mgr.cache.hits;
    const b = await mgr.analyzeProject("fixture"); // unchanged -> cache hit
    expect(mgr.cache.hits).toBe(hitBefore + 1);

    // Cache hit returns the SAME context object (work skipped, not recomputed).
    expect(b).toBe(a);
  });

  it("writes a persisted cache snapshot with a Merkle hash", async () => {
    mgr.cache.invalidate("fixture");
    await mgr.analyzeProject("fixture");
    const snap = await mgr.cache.readSnapshot("fixture");
    expect(snap).not.toBeNull();
    expect(snap!.merkleHash.length).toBeGreaterThan(0);
    expect(snap!.functionCount).toBeGreaterThan(0);
  });

  it("invalidates the cache after the fixture source changes", async () => {
    mgr.cache.invalidate("fixture");
    const before = await mgr.analyzeProject("fixture");
    await writeFile(
      join(fixtureRoot, "src", "fixture.cpp"),
      FIXTURE_CPP + "\nvoid fixtureGamma() { fixtureBeta(); }\n",
      "utf8",
    );
    const after = await mgr.analyzeProject("fixture");
    expect(after).not.toBe(before); // re-analyzed, not served from cache
    expect(after.functions.map((f) => f.name)).toContain("fixtureGamma");
  });
});
