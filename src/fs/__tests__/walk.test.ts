/**
 * collectFilesByExt — directory-pruning walk: collects source files, never
 * descends into node_modules/dist/.git/.anatomia.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFilesByExt, EXCLUDE_DIRS } from "../walk.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anatomia-walk-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const EXTS = new Set([".ts", ".cpp"]);

async function write(rel: string, content = "x"): Promise<void> {
  const full = join(dir, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content, "utf8");
}

describe("collectFilesByExt", () => {
  it("collects matching files recursively and ignores other extensions", async () => {
    await write("a.ts");
    await write("sub/b.cpp");
    await write("sub/deep/c.ts");
    await write("readme.md"); // not in EXTS
    const found = (await collectFilesByExt(dir, EXTS)).map((p) => p.replace(/\\/g, "/"));
    expect(found.some((p) => p.endsWith("/a.ts"))).toBe(true);
    expect(found.some((p) => p.endsWith("/sub/b.cpp"))).toBe(true);
    expect(found.some((p) => p.endsWith("/sub/deep/c.ts"))).toBe(true);
    expect(found.some((p) => p.endsWith("readme.md"))).toBe(false);
    expect(found).toHaveLength(3);
  });

  it("prunes excluded directories (node_modules/dist/.git/.anatomia)", async () => {
    await write("keep.ts");
    await write("node_modules/pkg/index.ts");
    await write("dist/out.ts");
    await write(".git/hooks/x.ts");
    await write(".anatomia/cache.ts");
    const found = (await collectFilesByExt(dir, EXTS)).map((p) => p.replace(/\\/g, "/"));
    expect(found).toHaveLength(1);
    expect(found[0].endsWith("/keep.ts")).toBe(true);
    // sanity: the default exclusion set is what we expect
    expect([...EXCLUDE_DIRS].sort()).toEqual([".anatomia", ".git", "dist", "node_modules"]);
  });

  it("skips nested git worktrees and separate clones but keeps submodules", async () => {
    await write("src/keep.ts");
    await write(".wt-task/.git", "gitdir: E:/repo/.git/worktrees/wt-task\n");
    await write(".wt-task/src/copy.ts");
    await write("win-wt/.git", "gitdir: C:\\repo\\.git\\worktrees\\win-wt\n");
    await write("win-wt/copy.ts");
    await write("vendor-clone/.git/HEAD", "ref: refs/heads/main\n");
    await write("vendor-clone/lib.ts");
    await write("lib/sub/.git", "gitdir: ../../.git/modules/lib/sub\n");
    await write("lib/sub/module.ts");
    const found = (await collectFilesByExt(dir, EXTS)).map((p) => p.replace(/\\/g, "/")).sort();
    expect(found.map((p) => p.slice(dir.replace(/\\/g, "/").length + 1))).toEqual(["lib/sub/module.ts", "src/keep.ts"]);
  });

  it("still walks the root even when the root itself is a worktree", async () => {
    await write(".git", "gitdir: E:/repo/.git/worktrees/root\n");
    await write("a.ts");
    expect(await collectFilesByExt(dir, EXTS)).toHaveLength(1);
  });

  it("honours a custom exclusion set", async () => {
    await write("keep.ts");
    await write("vendor/v.ts");
    const found = await collectFilesByExt(dir, EXTS, new Set(["vendor"]));
    expect(found).toHaveLength(1);
  });

  it("returns [] for a missing directory (no crash)", async () => {
    expect(await collectFilesByExt(join(dir, "nope"), EXTS)).toEqual([]);
  });
});
