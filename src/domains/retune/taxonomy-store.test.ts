import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTaxonomy } from "./taxonomy-store.js";
import type { Taxonomy } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("loadTaxonomy", () => {
  it("fails fast when a legacy taxonomy materialises unassigned as a domain", async () => {
    const repo = await mkdtemp(join(tmpdir(), "anatomia-taxonomy-store-"));
    roots.push(repo);
    const dataDir = join(repo, "spec", "data");
    await mkdir(dataDir, { recursive: true });
    const invalid: Taxonomy = {
      version: 1,
      project: "demo",
      iterations: 1,
      domains: [{
        name: "unassigned",
        description: "relation state",
        modules: [{ name: "legacy", description: "", paths: ["^src/"] }],
      }],
    };
    await writeFile(
      join(dataDir, "demo.taxonomy.json"),
      JSON.stringify(invalid),
      "utf8",
    );

    await expect(loadTaxonomy(repo, "demo"))
      .rejects.toThrow(/reserved for the unassigned relation state/);
  });
});
