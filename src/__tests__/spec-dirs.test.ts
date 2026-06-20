/**
 * analyze({ specDirs }) — spec clauses can be sourced from directories OUTSIDE
 * the code root. This is the case that matters when a project's code root is a
 * subdir (e.g. <repo>/src) but its spec lives at a sibling (<repo>/spec): the
 * default scan of repoPath alone finds nothing, and specDirs closes the gap.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "../core.js";

let repo: string;
let codeRoot: string;
let specDir: string;

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "anatomia-specdirs-"));
  codeRoot = join(repo, "src");
  specDir = join(repo, "spec");
  await mkdir(codeRoot, { recursive: true });
  await mkdir(specDir, { recursive: true });
  await writeFile(join(codeRoot, "enemy.cpp"), "int spawn_slime() { return 1; }\n");
  await writeFile(
    join(specDir, "Enemy.md"),
    "# Enemy spawning\n\nEnemies are created by spawn functions.\n",
  );
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("analyze specDirs", () => {
  it("finds no spec clauses when only the code root (sibling spec) is scanned", async () => {
    const ctx = await analyze(codeRoot, { quiet: true });
    expect(ctx.specClauses!.length).toBe(0);
  });

  it("finds the sibling spec/ clauses when specDirs points at it", async () => {
    const ctx = await analyze(codeRoot, { quiet: true, specDirs: [specDir] });
    expect(ctx.specClauses!.length).toBeGreaterThan(0);
    const headings = ctx.specClauses!.map((c) => c.heading ?? "");
    expect(headings.some((h) => h.includes("Enemy spawning"))).toBe(true);
  });

  it("de-dupes when a specDir overlaps the code root (no double-count)", async () => {
    // Passing the code root itself as a specDir must not double-count its files.
    const a = await analyze(codeRoot, { quiet: true, specDirs: [specDir] });
    const b = await analyze(codeRoot, { quiet: true, specDirs: [specDir, codeRoot] });
    expect(b.specClauses!.length).toBe(a.specClauses!.length);
  });
});
