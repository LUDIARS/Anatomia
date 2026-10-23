/**
 * vitest.setup.ts must win over whatever hooks the host session injects:
 * fixture repos ran a Concordia session hook on every commit and timed out.
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("test git environment", () => {
  it("points core.hooksPath of a fixture repo at a directory that does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anatomia-hermetic-git-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir, windowsHide: true });
      const hooksPath = execFileSync("git", ["config", "core.hooksPath"], {
        cwd: dir, encoding: "utf8", windowsHide: true,
      }).trim();
      expect(hooksPath).toBe(join(tmpdir(), "anatomia-test-no-git-hooks"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
