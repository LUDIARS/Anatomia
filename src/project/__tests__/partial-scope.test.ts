/**
 * src/project/__tests__/partial-scope.test.ts — scoped analyzeProject().
 *
 * A partial / staged analysis (analyzeProject with a restricting scope) must
 * return the scoped context but NEVER persist it as the project's canonical
 * snapshot — a later full analyze must not be short-circuited by a partial one.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ProjectRegistry } from "../registry.js";
import { ProjectManager } from "../index.js";

let home: string;
let fixtureRoot: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "anatomia-scope-home-"));
  fixtureRoot = await mkdtemp(join(tmpdir(), "anatomia-scope-fixture-"));
  await mkdir(join(fixtureRoot, "combat"), { recursive: true });
  await mkdir(join(fixtureRoot, "ui"), { recursive: true });
  await writeFile(join(fixtureRoot, "combat", "attack.ts"), "export function attack() { return 1; }\n");
  await writeFile(join(fixtureRoot, "ui", "menu.ts"), "export function menu() { return 2; }\n");
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("ProjectManager partial scope", () => {
  it("returns a scoped context without caching it as the snapshot", async () => {
    const mgr = new ProjectManager(new ProjectRegistry(), {
      homeDir: home,
      analyzeOptions: { quiet: true },
    });
    await mgr.addProject({ name: "ScopeFixture", rootPath: fixtureRoot });

    const scoped = await mgr.analyzeProject("scopefixture", { scope: { paths: ["combat"] } });
    expect(scoped.partial).toEqual({ paths: ["combat"] });
    expect(scoped.functions.map((f) => f.name)).toEqual(["attack"]);

    // The partial result must not have been recorded as the canonical context:
    // the next (unscoped) analyze re-runs and sees the whole repo.
    const full = await mgr.analyzeProject("scopefixture");
    expect(full.partial).toBeUndefined();
    expect(full.functions.map((f) => f.name).sort()).toEqual(["attack", "menu"]);
  });

  it("serves a fresh full cache to a scoped request (superset short-circuit)", async () => {
    const mgr = new ProjectManager(new ProjectRegistry(), {
      homeDir: home,
      analyzeOptions: { quiet: true },
    });
    await mgr.addProject({ name: "ScopeFixture2", rootPath: fixtureRoot });

    const full = await mgr.analyzeProject("scopefixture2");
    expect(full.partial).toBeUndefined();

    const before = mgr.cache.hits;
    const scoped = await mgr.analyzeProject("scopefixture2", { scope: { paths: ["combat"] } });
    // Fingerprint unchanged → the canonical full context answers the scoped
    // request (it is a superset) without re-analysis.
    expect(mgr.cache.hits).toBe(before + 1);
    expect(scoped.partial).toBeUndefined();
    expect(scoped.functions.length).toBe(2);
  });
});
