import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTaxonomy, renderTaxonomyMd } from "./register.js";
import type { Taxonomy } from "./types.js";

const TAX: Taxonomy = {
  version: 1,
  project: "demo",
  iterations: 2,
  domains: [
    { name: "graph", description: "code graph", modules: [{ name: "graph-core", description: "core", paths: ["^src/graph/"] }] },
  ],
  unassigned: { count: 1, sample: ["src/x.ts:foo"] },
};

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "retune-reg-"));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("retune register", () => {
  it("writes domain defs, taxonomy json, and a markdown doc", async () => {
    const { written, ontologyDir } = await registerTaxonomy(repo, TAX);
    expect(written).toContain("spec/data/ontology/graph.domain.json");
    expect(written).toContain("spec/data/demo.taxonomy.json");
    expect(written).toContain("spec/feature/domain-taxonomy.demo.md");

    const def = JSON.parse(await readFile(join(ontologyDir, "graph.domain.json"), "utf8"));
    expect(def.name).toBe("graph");
    expect(def.presetRules).toEqual([]);
    expect(def.membership).toEqual([{ pathPattern: "^src/graph/" }]);

    const tax = JSON.parse(await readFile(join(repo, "spec", "data", "demo.taxonomy.json"), "utf8"));
    expect(tax.project).toBe("demo");

    const md = await readFile(join(repo, "spec", "feature", "domain-taxonomy.demo.md"), "utf8");
    expect(md).toMatch(/# ドメイン taxonomy: demo/);
    expect(md).toMatch(/graph-core/);
  });

  it("removes stale domain defs from a previous pass", async () => {
    const ontologyDir = join(repo, "spec", "data", "ontology");
    await mkdir(ontologyDir, { recursive: true });
    await writeFile(join(ontologyDir, "old-domain.domain.json"), "{}", "utf8");
    await registerTaxonomy(repo, TAX);
    const entries = await readdir(ontologyDir);
    expect(entries).not.toContain("old-domain.domain.json");
    expect(entries).toContain("graph.domain.json");
  });

  it("renderTaxonomyMd is plain markdown (no raw JSON body)", () => {
    const md = renderTaxonomyMd(TAX);
    expect(md).not.toMatch(/\{\s*"version"/);
    expect(md).toMatch(/## graph/);
    expect(md).toMatch(/未割当 \(1\)/);
  });
});
