/**
 * src/project/__tests__/spec-detect.test.ts — spec-source probing + auto-detection.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hasMarkdownSources, detectSpecDirCandidates } from "../spec-detect.js";
import { ProjectRegistry } from "../registry.js";
import { ProjectManager } from "../index.js";

let base: string;
let home: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "anatomia-specdetect-"));
  home = await mkdtemp(join(tmpdir(), "anatomia-specdetect-home-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

/** repo/ (.git) with code under repo/src and spec under repo/spec. */
async function makeSplitRepo(): Promise<{ repo: string; codeRoot: string; specDir: string }> {
  const repo = join(base, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "spec"), { recursive: true });
  await writeFile(join(repo, "src", "main.ts"), "export function main() {}\n");
  await writeFile(join(repo, "spec", "feature.md"), "# feature\n\n- does things\n");
  return { repo, codeRoot: join(repo, "src"), specDir: join(repo, "spec") };
}

describe("hasMarkdownSources", () => {
  it("true when markdown exists, false when none", async () => {
    const { codeRoot, specDir } = await makeSplitRepo();
    expect(await hasMarkdownSources(codeRoot)).toBe(false);
    expect(await hasMarkdownSources(specDir)).toBe(true);
  });
});

describe("detectSpecDirCandidates", () => {
  it("finds the repo-level spec dir for a code-subdir root", async () => {
    const { codeRoot, specDir } = await makeSplitRepo();
    expect(await detectSpecDirCandidates(codeRoot)).toEqual([specDir]);
  });

  it("never probes ancestors for a git-root project", async () => {
    // A workspace full of sibling clones: the neighbour's docs/ must NOT leak in.
    const repo = join(base, "standalone");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(base, "docs"), { recursive: true });
    await writeFile(join(base, "docs", "other.md"), "# other project's doc\n");
    expect(await detectSpecDirCandidates(repo)).toEqual([]);
  });

  it("returns empty when no candidate dir has markdown", async () => {
    const repo = join(base, "repo2");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(repo, "sub"), { recursive: true });
    await mkdir(join(repo, "docs"), { recursive: true }); // empty docs
    expect(await detectSpecDirCandidates(join(repo, "sub"))).toEqual([]);
  });
});

describe("ProjectManager.ensureSpecConfig", () => {
  it("resolves 'root' when the project root has markdown", async () => {
    const root = join(base, "mdroot");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "README.md"), "# hi\n");
    const mgr = new ProjectManager(new ProjectRegistry(), { homeDir: home, analyzeOptions: { quiet: true } });
    await mgr.addProject({ name: "MdRoot", rootPath: root });
    expect(await mgr.ensureSpecConfig("mdroot")).toEqual({ source: "root" });
  });

  it("auto-detects, persists, and reports 'auto' for a split repo", async () => {
    const { codeRoot, specDir } = await makeSplitRepo();
    const mgr = new ProjectManager(new ProjectRegistry(), { homeDir: home, analyzeOptions: { quiet: true } });
    await mgr.addProject({ name: "Split", rootPath: codeRoot });

    const status = await mgr.ensureSpecConfig("split");
    expect(status).toEqual({ source: "auto", dirs: [specDir] });
    // Persisted on the project record, flagged as auto.
    const project = mgr.get("split")!;
    expect(project.specDirs).toEqual([specDir]);
    expect(project.specDirsAuto).toBe(true);

    // A fresh manager (fresh registry load) sees the persisted auto config.
    const mgr2 = await ProjectManager.load({ homeDir: home, analyzeOptions: { quiet: true } });
    expect(await mgr2.ensureSpecConfig("split")).toEqual({ source: "auto", dirs: [specDir] });
  });

  it("reports 'missing' when nothing is found", async () => {
    const root = join(base, "bare");
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, "main.ts"), "export function main() {}\n");
    const mgr = new ProjectManager(new ProjectRegistry(), { homeDir: home, analyzeOptions: { quiet: true } });
    await mgr.addProject({ name: "Bare", rootPath: root });
    expect(await mgr.ensureSpecConfig("bare")).toEqual({ source: "missing" });
  });

  it("user-set dirs win ('configured') and clearing returns to auto-detect", async () => {
    const { codeRoot, specDir } = await makeSplitRepo();
    const other = join(base, "otherspec");
    await mkdir(other, { recursive: true });
    await writeFile(join(other, "x.md"), "# x\n");

    const mgr = new ProjectManager(new ProjectRegistry(), { homeDir: home, analyzeOptions: { quiet: true } });
    await mgr.addProject({ name: "Cfg", rootPath: codeRoot });

    await mgr.updateSpecDirs("cfg", [other]);
    expect(await mgr.ensureSpecConfig("cfg")).toEqual({ source: "configured", dirs: [other] });
    expect(mgr.get("cfg")!.specDirsAuto).toBeUndefined();

    await mgr.updateSpecDirs("cfg", null);
    expect(await mgr.ensureSpecConfig("cfg")).toEqual({ source: "auto", dirs: [specDir] });
  });

  it("rejects nonexistent dirs on set", async () => {
    const { codeRoot } = await makeSplitRepo();
    const mgr = new ProjectManager(new ProjectRegistry(), { homeDir: home, analyzeOptions: { quiet: true } });
    await mgr.addProject({ name: "Bad", rootPath: codeRoot });
    await expect(mgr.updateSpecDirs("bad", [join(base, "no-such-dir")])).rejects.toThrow(
      /does not exist/,
    );
  });

  it("analyzeProject links spec clauses through the auto-detected dir", async () => {
    const { codeRoot } = await makeSplitRepo();
    const mgr = new ProjectManager(new ProjectRegistry(), { homeDir: home, analyzeOptions: { quiet: true } });
    await mgr.addProject({ name: "Linked", rootPath: codeRoot });
    const ctx = await mgr.analyzeProject("linked");
    expect((ctx.specClauses ?? []).length).toBeGreaterThan(0);
  });
});
