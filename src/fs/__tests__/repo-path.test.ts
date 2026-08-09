/**
 * Repo-relative identity — the property that lets two checkouts of the same
 * commit share anchors and cache keys (fs/repo-path.ts, dag/hash.ts).
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "../../core.js";
import { toRepoRelative, fromRepoRelative, normalizeSlashes } from "../repo-path.js";
import { filesContentKey } from "../../graph/cache.js";

describe("toRepoRelative / fromRepoRelative", () => {
  it("strips and restores the repo root", () => {
    const abs = "E:/repo/src/a.ts";
    expect(toRepoRelative(abs, "E:/repo")).toBe("src/a.ts");
    expect(fromRepoRelative("src/a.ts", "E:/repo")).toBe(abs);
  });

  it("normalises separators and a trailing root separator", () => {
    expect(toRepoRelative("E:\\repo\\src\\a.ts", "E:\\repo\\")).toBe("src/a.ts");
    expect(toRepoRelative("E:/src/a.ts", "E:/")).toBe("src/a.ts");
    expect(fromRepoRelative("src/a.ts", "E:/")).toBe("E:/src/a.ts");
    expect(toRepoRelative("/src/a.ts", "/")).toBe("src/a.ts");
    expect(fromRepoRelative("src/a.ts", "/")).toBe("/src/a.ts");
  });

  it("matches the root case-insensitively", () => {
    // Windows reaches the same file through either case; a case-only mismatch
    // must not fall back to the absolute form and split the identity again.
    expect(toRepoRelative("E:/Repo/src/a.ts", "e:/repo")).toBe("src/a.ts");
  });

  it("leaves a path outside the root, or already relative, alone", () => {
    expect(toRepoRelative("D:/other/a.ts", "E:/repo")).toBe("D:/other/a.ts");
    expect(toRepoRelative("<diff>", "E:/repo")).toBe("<diff>");
    expect(normalizeSlashes("./a/b/")).toBe("a/b");
  });

  it("normalises dot segments without treating an escaped path as repo-relative", () => {
    expect(toRepoRelative("E:/repo/src/../a.ts", "E:/repo")).toBe("a.ts");
    expect(toRepoRelative("E:/repo/../private.txt", "E:/repo")).toBe("E:/private.txt");
    expect(() => fromRepoRelative("src/../../private.txt", "E:/repo"))
      .toThrow(/escapes its root/);
    expect(() => fromRepoRelative("E:/already/abs.ts", "E:/repo"))
      .toThrow(/expected a repo-relative path/);
  });

  it("keeps POSIX path matching case-sensitive", () => {
    expect(toRepoRelative("/repo/src/a.ts", "/Repo")).toBe("/repo/src/a.ts");
  });
});

describe("cross-checkout identity", () => {
  it("gives the same anchors and cache key to two checkouts of the same source", async () => {
    // Two directories standing in for a repo and a worktree of it: identical
    // content at identical repo-relative paths, different absolute paths.
    const roots = await Promise.all([
      mkdtemp(join(tmpdir(), "anatomia-checkout-a-")),
      mkdtemp(join(tmpdir(), "anatomia-checkout-b-")),
    ]);
    try {
      for (const root of roots) {
        await writeFile(
          join(root, "a.ts"),
          "export function alpha(x: number) { return x + 1; }\n",
          "utf8",
        );
      }
      const [first, second] = await Promise.all(
        roots.map((root) => analyze(root, { quiet: true })),
      );

      const anchorsOf = (ctx: { functions: { name: string; id: string | null }[] }) =>
        ctx.functions.map((fn) => `${fn.name}:${fn.id}`).sort();
      expect(anchorsOf(first)).toEqual(anchorsOf(second));
      expect(first.functions.length).toBeGreaterThan(0);

      // ...and therefore the same content key, so a cache warmed by one checkout
      // is readable by the other.
      expect(filesContentKey(first.files, first.repoPath))
        .toBe(filesContentKey(second.files, second.repoPath));

      // Without a root the absolute paths leak back in and the identities split
      // again — the regression this guards.
      expect(filesContentKey(first.files)).not.toBe(filesContentKey(second.files));
    } finally {
      await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });
});
