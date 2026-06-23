import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTaxonomyResolver } from "./load-taxonomy.js";
import type { Taxonomy } from "./types.js";

const TAX: Taxonomy = {
  version: 1,
  project: "demo",
  iterations: 1,
  domains: [{ name: "graph", description: "g", modules: [{ name: "core", description: "", paths: ["(^|/)src/graph/[^/]+$"] }] }],
};

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "retune-load-"));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("loadTaxonomyResolver", () => {
  it("returns undefined when no taxonomy file exists", async () => {
    expect(await loadTaxonomyResolver(repo)).toBeUndefined();
  });

  it("loads a *.taxonomy.json and resolves modules (abs + rel paths)", async () => {
    await mkdir(join(repo, "spec", "data"), { recursive: true });
    await writeFile(join(repo, "spec", "data", "demo.taxonomy.json"), JSON.stringify(TAX), "utf8");
    const resolver = await loadTaxonomyResolver(repo);
    expect(resolver).toBeTypeOf("function");
    expect(resolver!("src/graph/build.ts", "x")).toBe("core");
    expect(resolver!("E:/repo/src/graph/build.ts", "x")).toBe("core");
    expect(resolver!("src/other/x.ts", "x")).toBeNull();
  });

  it("returns undefined on malformed JSON", async () => {
    await mkdir(join(repo, "spec", "data"), { recursive: true });
    await writeFile(join(repo, "spec", "data", "bad.taxonomy.json"), "{ not json", "utf8");
    expect(await loadTaxonomyResolver(repo)).toBeUndefined();
  });
});
