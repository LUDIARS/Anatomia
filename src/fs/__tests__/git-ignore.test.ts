/**
 * Ignored-path discovery: analysis must skip whatever git ignores, while
 * untracked-but-not-ignored files stay visible (they are what the verify pass
 * is usually looking at).
 *
 * These drive a real `git` in a temp repo — the whole point is that we defer to
 * git's own semantics, so stubbing it would test nothing. Same precedent as
 * branch/__tests__/diff.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listGitIgnoredPaths } from "../git-ignore.js";
import { collectProjectFiles } from "../walk.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anatomia-gitignore-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const EXTS = new Set([".ts", ".log"]);

async function write(rel: string, content = "x"): Promise<void> {
  const full = join(dir, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content, "utf8");
}

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore", windowsHide: true });
}

/** Init a repo and commit whatever is staged, without touching global config. */
function commitAll(): void {
  git("add", "-A");
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "init"],
    { cwd: dir, stdio: "ignore", windowsHide: true },
  );
}

const rel = (paths: string[]): string[] =>
  paths.map((p) => p.slice(dir.length + 1).replace(/\\/g, "/")).sort();

describe("listGitIgnoredPaths", () => {
  it("returns null outside a git work tree", async () => {
    expect(await listGitIgnoredPaths(dir)).toBeNull();
  });

  it("reports the patterns the old bare-name reader could not express", async () => {
    git("init", "-q");
    // Each of these was invisible to readGitignoreDirs: root-anchored, glob,
    // and a rule living in a nested .gitignore.
    await write(".gitignore", "/build\n*.log\n");
    await write("nested/.gitignore", "generated/\n");
    await write("keep.ts");
    commitAll();
    await write("build/out.ts");
    await write("debug.log");
    await write("nested/generated/g.ts");

    const ignored = await listGitIgnoredPaths(dir);
    expect(ignored).not.toBeNull();
    expect(ignored!.dirs.has("build")).toBe(true);
    expect(ignored!.dirs.has("nested/generated")).toBe(true);
    expect(ignored!.files.has("debug.log")).toBe(true);
    expect(ignored!.files.has("keep.ts")).toBe(false);
  });

  it("does not see inside a directory holding no tracked file (documented gap)", async () => {
    git("init", "-q");
    await write(".gitignore", "generated/\n");
    await write("keep.ts");
    commitAll();
    // `fresh/` has nothing tracked, so --directory collapses it and the ignored
    // child below is never listed. Pinned so the day it changes is deliberate.
    await write("fresh/generated/g.ts");

    const ignored = await listGitIgnoredPaths(dir);
    expect(ignored!.dirs.has("fresh/generated")).toBe(false);
  });
});

describe("collectProjectFiles", () => {
  it("drops ignored paths but keeps untracked ones", async () => {
    git("init", "-q");
    await write(".gitignore", "/build\n*.log\n");
    await write("build/out.ts");
    await write("debug.log");
    await write("committed.ts");
    commitAll();
    // Written after the commit: untracked, not ignored — must still be analyzed.
    await write("brand-new.ts");

    expect(rel(await collectProjectFiles(dir, EXTS))).toEqual(["brand-new.ts", "committed.ts"]);
  });

  it("keeps a tracked file even when a later rule would match it", async () => {
    git("init", "-q");
    await write("tracked.log");
    commitAll();
    // git does not ignore what it already tracks, and neither should analysis.
    await write(".gitignore", "*.log\n");
    await write("untracked.log");

    expect(rel(await collectProjectFiles(dir, EXTS))).toEqual(["tracked.log"]);
  });

  it("still prunes the built-in directories outside a git repo", async () => {
    await write("keep.ts");
    await write("node_modules/pkg/index.ts");

    expect(rel(await collectProjectFiles(dir, EXTS))).toEqual(["keep.ts"]);
  });

  it("falls back to the root .gitignore's bare directory names outside a git repo", async () => {
    // No repo, so listGitIgnoredPaths returns null and buildIgnorePolicy drops
    // back to readGitignoreDirs. That branch is the only thing keeping non-git
    // directories analyzable, and nothing else exercises it.
    await write(".gitignore", "vendor/\n");
    await write("keep.ts");
    await write("vendor/v.ts");

    expect(rel(await collectProjectFiles(dir, EXTS))).toEqual(["keep.ts"]);
  });
});
