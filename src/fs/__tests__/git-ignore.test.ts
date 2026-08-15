/**
 * Ignored-path discovery: analysis must skip whatever git ignores, while
 * untracked-but-not-ignored files stay visible (they are what the verify pass
 * is usually looking at).
 *
 * These drive a real `git` in a temp repo — the whole point is that we defer to
 * git's own semantics, so stubbing it would test nothing. Same precedent as
 * branch/__tests__/diff.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listGitIgnoredPaths, queryGitIgnoredPaths } from "../git-ignore.js";
import { collectProjectFiles, scanGitignoreDirs } from "../walk.js";

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
    // Each of these was invisible to the old bare-name reader: root-anchored, glob,
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

  it("finds an ignored directory inside a directory holding no tracked file", async () => {
    git("init", "-q");
    await write(".gitignore", "generated/\n");
    await write("keep.ts");
    commitAll();
    // `fresh/` has nothing tracked, but git still reports its ignored child
    // directory so the walker can prune it.
    await write("fresh/generated/g.ts");

    const ignored = await listGitIgnoredPaths(dir);
    expect(ignored!.dirs.has("fresh/generated")).toBe(true);
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
    // back to the crude reader. That branch is the only thing keeping non-git
    // directories analyzable, and nothing else exercises it.
    await write(".gitignore", "vendor/\n");
    await write("keep.ts");
    await write("vendor/v.ts");

    expect(rel(await collectProjectFiles(dir, EXTS))).toEqual(["keep.ts"]);
  });
});

describe("fallback diagnosis", () => {
  it("reports which rules the crude reader cannot express", async () => {
    // A real .gitignore from a C++ repo: every meaningful rule is either
    // root-anchored or globbed, so the fallback keeps none of them.
    await write(".gitignore", "/build*/\n/.deps/\n/runtime/\nout/\n*.onnx\n# comment\n");

    const scan = await scanGitignoreDirs(dir);
    expect([...scan.dirs]).toEqual(["out"]);
    expect(scan.skipped).toEqual(["/build*/", "/.deps/", "/runtime/", "*.onnx"]);
  });

  it("classifies a missing work tree as unavailable, not refused", async () => {
    const result = await queryGitIgnoredPaths(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("unavailable");
  });

  it("classifies a git that ran and refused as refused", async () => {
    // A broken config makes git fail for a reason an operator can fix, which is
    // the same shape as the dubious-ownership refusal that motivated this split.
    git("init");
    await writeFile(join(dir, ".git", "config"), "[core\n", "utf8");

    const result = await queryGitIgnoredPaths(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("refused");
  });

  it("warns when the fallback silently drops ignore rules", async () => {
    await write(".gitignore", "/vendor/\n");
    await write("keep.ts");
    await write("vendor/v.ts");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Root-anchored, so the fallback does not exclude it — the file is analyzed.
    expect(rel(await collectProjectFiles(dir, EXTS))).toEqual(["keep.ts", "vendor/v.ts"]);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("1 rule(s)");
    expect(message).not.toContain(dir);
    expect(message).not.toContain("/vendor/");
    warn.mockRestore();
  });

  it("stays quiet when the fallback loses nothing", async () => {
    // The case the fallback was built for: no repo, and a .gitignore it can
    // express in full. Warning here would train everyone to ignore the warning.
    await write(".gitignore", "vendor/\n");
    await write("keep.ts");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await collectProjectFiles(dir, EXTS);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
