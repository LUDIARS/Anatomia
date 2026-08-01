import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assessDomainHealth } from "./warnings.js";

describe("domain health warnings", () => {
  it("counts detected semantic domains without subtracting builtin policies", async () => {
    const repo = await mkdtemp(join(tmpdir(), "anatomia-domain-health-"));
    try {
      await mkdir(join(repo, "spec", "data"), { recursive: true });
      await writeFile(
        join(repo, "spec", "data", "demo.taxonomy.json"),
        JSON.stringify({
          version: 1,
          project: "demo",
          iterations: 0,
          domains: [
            { name: "capture", description: "capture", modules: [] },
            { name: "review", description: "review", modules: [] },
            { name: "reporting", description: "reporting", modules: [] },
          ],
        }),
        "utf8",
      );

      const health = await assessDomainHealth({
        repoPath: repo,
        functions: [{}, {}, {}],
        domains: [{ implementors: [] }],
      });

      expect(health.expectedCuratedDomains).toBe(3);
      expect(health.builtinDomains).toBe(0);
      expect(health.detectedCuratedDomains).toBe(1);
      expect(health.warnings[0]?.code).toBe("domain-count-low-vs-taxonomy");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("warns on a complete domain detection failure for non-trivial projects", async () => {
    const repo = await mkdtemp(join(tmpdir(), "anatomia-domain-health-empty-"));
    try {
      const health = await assessDomainHealth({
        repoPath: repo,
        functions: Array.from({ length: 20 }, () => ({})),
        domains: [],
      });
      expect(health.warnings[0]?.code).toBe("domain-count-zero");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
