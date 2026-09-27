import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnalysisContext } from "../core.js";
import { readLocatorComments } from "./domain-locator-comments.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("locator comment preparation", () => {
  it("reads a preceding spec comment block and reports unavailable source", async () => {
    const root = await mkdtemp(join(tmpdir(), "an-comment-")); dirs.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "case.ts"), "// @spec checkout\n// Place an order\nfunction place() {}\n", "utf8");
    const ctx = { repoPath: root, functions: [
      { sourceRange: { filePath: join(root, "src", "case.ts"), start: { line: 2 } } },
      { sourceRange: { filePath: join(root, "src", "missing.ts"), start: { line: 1 } } },
      { sourceRange: { filePath: join(root, "..", "outside.ts"), start: { line: 1 } } },
    ] } as unknown as AnalysisContext;
    const result = await readLocatorComments(ctx);
    expect(result.comments.get(`src/case.ts\0${2}`)).toContain("@spec checkout");
    expect(result.unavailable).toHaveLength(2);
    expect(result.unavailable.some((row) => row.includes("outside repository"))).toBe(true);
  });
});
