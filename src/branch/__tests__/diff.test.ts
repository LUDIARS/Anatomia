/**
 * computeBranchDiff — function-level branch diff over a real (temp) git repo.
 *
 * Builds a tiny git repo with a base commit on `main`, branches off, edits the
 * working tree, then asserts the added/changed/removed classification and that
 * the reported anchors line up with the analyzed graph.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "../../core.js";
import { computeBranchDiff } from "../diff.js";
import { listBranches } from "../git.js";

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

const BASE = `export function alpha(x: number): number { return x + 1; }
export function beta(): void {}
`;
const AFTER = `export function alpha(x: number): number { let y = x * 2; return y + 1; }
export function beta(): void {}
export function gamma(): number { return 42; }
`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anatomia-branchdiff-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("computeBranchDiff", () => {
  it("returns available:false outside a git repository", async () => {
    const ctx = await analyze(dir, { quiet: true });
    const diff = await computeBranchDiff(ctx);
    expect(diff.available).toBe(false);
    expect(diff.reason).toMatch(/not a git repository/);
  });

  it("classifies added / changed functions vs the merge-base", async () => {
    // git init + analyze + branch-diff is slow under suite parallelism on Windows
    git(dir, ["init"]);
    // Name the (unborn) default branch "main" — works on git < 2.28 where
    // `git init -b main` / init.defaultBranch are unavailable.
    git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(dir, ["config", "user.email", "test@example.com"]);
    git(dir, ["config", "user.name", "test"]);
    await writeFile(join(dir, "mod.ts"), BASE, "utf8");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "base"]);

    // Branch off and edit the working tree (uncommitted).
    git(dir, ["checkout", "-b", "feature"]);
    await writeFile(join(dir, "mod.ts"), AFTER, "utf8");

    const ctx = await analyze(dir, { quiet: true });
    const diff = await computeBranchDiff(ctx);

    expect(diff.available).toBe(true);
    expect(diff.branch).toBe("feature");
    expect(diff.base).toBe("main");
    expect(diff.summary.filesChanged).toBe(1);

    const file = diff.files.find((f) => f.path === "mod.ts")!;
    expect(file).toBeTruthy();
    expect(file.added.map((f) => f.name)).toEqual(["gamma"]);
    expect(file.changed.map((f) => f.name)).toEqual(["alpha"]);
    expect(file.removed).toHaveLength(0);

    // Reported anchors must exist in the analyzed graph (diff is a view over it).
    const graphIds = new Set((await ctx.graph.allNodes()).map((n) => String(n.id)));
    for (const a of diff.anchors.all) expect(graphIds.has(a)).toBe(true);
    expect(diff.anchors.added.length).toBe(1);
    expect(diff.anchors.changed.length).toBe(1);
  }, 60_000);
});

describe("listBranches", () => {
  it("lists other branches, excluding the current one, outside-of-repo = []", async () => {
    expect(await listBranches(dir)).toEqual([]); // not a git repo yet

    git(dir, ["init"]);
    git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(dir, ["config", "user.email", "test@example.com"]);
    git(dir, ["config", "user.name", "test"]);
    await writeFile(join(dir, "mod.ts"), BASE, "utf8");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "base"]);
    git(dir, ["branch", "develop"]);
    git(dir, ["checkout", "-b", "feature"]);

    const branches = await listBranches(dir);
    expect(branches).toContain("main"); // known base candidate surfaced
    expect(branches).toContain("develop");
    expect(branches).not.toContain("feature"); // current branch excluded
    expect(branches[0]).toBe("main"); // DEFAULT_BASE_CANDIDATES first
  }, 60_000);
});
