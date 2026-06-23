import { describe, it, expect } from "vitest";
import {
  escapeRegex,
  pathPatternForDir,
  kebab,
  emptyTaxonomy,
  findOrCreateDomain,
  findOrCreateModule,
  addDir,
  moduleNodeCounts,
  splitDomain,
  mergeModules,
  findModule,
} from "./taxonomy-ops.js";
import type { NodeSummary } from "./types.js";

function n(relPath: string, name: string): NodeSummary {
  return { id: relPath, name, relPath, dir: relPath.replace(/\/[^/]+$/, ""), cyclomatic: 1, fanIn: 0, fanOut: 0, coupling: 0, size: 1 };
}

describe("retune taxonomy-ops", () => {
  it("pathPatternForDir matches files directly in the dir (no catch-all)", () => {
    expect(pathPatternForDir("src/graph")).toBe("(^|/)src/graph/[^/]+$");
    expect(pathPatternForDir("src/graph/")).toBe("(^|/)src/graph/[^/]+$");
    expect(escapeRegex("a.b")).toBe("a\\.b");
    // The shallow "src" dir owns only its direct files, not the whole tree.
    expect(new RegExp(pathPatternForDir("src")).test("src/core.ts")).toBe(true);
    expect(new RegExp(pathPatternForDir("src")).test("src/graph/build.ts")).toBe(false);
  });

  it("kebab normalizes names", () => {
    expect(kebab("Spec Linkage")).toBe("spec-linkage");
    expect(kebab("")).toBe("unnamed");
  });

  it("findOrCreate is idempotent and addDir dedupes", () => {
    const t = emptyTaxonomy("p");
    const d1 = findOrCreateDomain(t, "Graph", "g");
    const d2 = findOrCreateDomain(t, "graph", "other");
    expect(d1).toBe(d2);
    expect(t.domains).toHaveLength(1);
    const m = findOrCreateModule(d1, "core", "c");
    addDir(m, "src/graph");
    addDir(m, "src/graph");
    expect(m.paths).toEqual(["(^|/)src/graph/[^/]+$"]);
  });

  it("moduleNodeCounts counts owned nodes", () => {
    const t = emptyTaxonomy("p");
    const d = findOrCreateDomain(t, "graph", "g");
    const m = findOrCreateModule(d, "core", "c");
    addDir(m, "src/graph");
    const counts = moduleNodeCounts(t, [n("src/graph/a.ts", "a"), n("src/graph/b.ts", "b"), n("src/x/c.ts", "c")]);
    expect(counts.get("graph/core")).toBe(2);
  });

  it("splitDomain partitions modules into sub-domains", () => {
    const t = emptyTaxonomy("p");
    const d = findOrCreateDomain(t, "big", "b");
    for (const name of ["m1", "m2", "m3"]) addDir(findOrCreateModule(d, name, ""), `src/${name}`);
    const ok = splitDomain(t, "big", [
      { name: "sub-a", description: "", modules: ["m1"] },
      { name: "sub-b", description: "", modules: ["m2"] },
    ]);
    expect(ok).toBe(true);
    expect(t.domains.map((x) => x.name).sort()).toEqual(["sub-a", "sub-b"]);
    // m3 (unassigned) falls to the first sub-domain.
    expect(findModule(t, "m3")!.domain.name).toBe("sub-a");
  });

  it("mergeModules unions paths and removes sources", () => {
    const t = emptyTaxonomy("p");
    const d = findOrCreateDomain(t, "dom", "d");
    addDir(findOrCreateModule(d, "a", ""), "src/a");
    addDir(findOrCreateModule(d, "b", ""), "src/b");
    const ok = mergeModules(t, "dom", "ab", "merged", ["a", "b"]);
    expect(ok).toBe(true);
    expect(d.modules.map((m) => m.name)).toEqual(["ab"]);
    expect(d.modules[0]!.paths.sort()).toEqual(["(^|/)src/a/[^/]+$", "(^|/)src/b/[^/]+$"]);
  });

  it("mergeModules refuses a single-source merge", () => {
    const t = emptyTaxonomy("p");
    const d = findOrCreateDomain(t, "dom", "d");
    addDir(findOrCreateModule(d, "a", ""), "src/a");
    expect(mergeModules(t, "dom", "ab", "", ["a"])).toBe(false);
  });
});
