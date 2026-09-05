/**
 * Regression tests for the two quality defects measured on the first plan PR:
 *
 *   (a) 「データ定義」 filled up with container accessors (`size`, `empty`,
 *       `count`, `begin`, `end`) instead of the domain's API.
 *   (b) the 手本 (exemplar) was chosen by reference count alone, which lands on
 *       an accessor — `snippet_cache.h:size` — because accessors are the
 *       most-referenced functions in any codebase.
 *
 * Both are pinned here so a future ranking change cannot reintroduce them.
 */

import { describe, expect, it } from "vitest";
import type { AnalysisContext } from "../../../core.js";
import { collectDataDefs } from "../data-defs.js";
import { findExemplar, pickExemplarSibling } from "../exemplar.js";
import { isAccessorName, isPublicApiName } from "../public-api.js";
import type { PlanRepo } from "../collect.js";
import type { PlanDomainCandidate } from "../types.js";
import { anchor, file, fn, graphStub } from "./helpers.js";

/**
 * One domain whose most-referenced members are accessors — the shape that
 * produced both defects.
 */
function cacheRepo(): PlanRepo {
  const size = fn("aaaa", "size", "/repo/src/graph/snippet_cache.h");
  const empty = fn("bbbb", "empty", "/repo/src/graph/snippet_cache.h");
  const begin = fn("cccc", "begin", "/repo/src/graph/snippet_cache.h");
  const equals = fn("dddd", "operator==", "/repo/src/graph/snippet_cache.h");
  const make = fn("eeee", "MakeSnippetCache", "/repo/src/graph/snippet_cache.cpp");
  const evict = fn("ffff", "EvictSnippet", "/repo/src/graph/evict.cpp");
  const functions = [size, empty, begin, equals, make, evict];
  const ctx: AnalysisContext = {
    repoPath: "/repo",
    graph: graphStub({ aaaa: 90, bbbb: 60, cccc: 55, dddd: 40, eeee: 6, ffff: 2 }),
    files: [
      file("/repo/src/graph/snippet_cache.h", ["SnippetCache"], [size, empty, begin, equals]),
      file("/repo/src/graph/snippet_cache.cpp", [], [make]),
      file("/repo/src/graph/evict.cpp", [], [evict]),
    ],
    functions,
    domains: [
      {
        domain: "snippet-cache",
        description: "スニペットの決定的キャッシュ。",
        implementors: functions.map((f) => anchor(f.id as unknown as string)),
        violations: [],
        conforms: true,
      },
    ],
  };
  return { id: "anatomia", repoPath: "/repo", ctx, ontologyDir: undefined };
}

const candidate: PlanDomainCandidate = {
  repo: "anatomia",
  name: "snippet-cache",
  description: "スニペットの決定的キャッシュ。",
  pathPatterns: ["(^|/)src/graph/[^/]+$"],
  implementors: 6,
};

describe("isAccessorName", () => {
  it("catches the container protocol and operator overloads", () => {
    for (const name of ["size", "empty", "count", "begin", "end", "data", "get_size", "operator=="]) {
      expect(isAccessorName(name)).toBe(true);
    }
  });

  it("keeps real API whose name merely starts with a verb", () => {
    for (const name of ["getSnapshot", "setUpPipeline", "MakeSnippetCache", "EvictSnippet"]) {
      expect(isAccessorName(name)).toBe(false);
      expect(isPublicApiName(name)).toBe(true);
    }
  });
});

describe("collectDataDefs", () => {
  it("lists the domain's API, not its accessors", async () => {
    const defs = await collectDataDefs(cacheRepo(), "snippet-cache", candidate);
    const functions = defs.filter((d) => d.kind === "function").map((d) => d.name);
    expect(functions).toContain("MakeSnippetCache");
    expect(functions).toContain("EvictSnippet");
    for (const accessor of ["size", "empty", "begin", "operator=="]) {
      expect(functions).not.toContain(accessor);
    }
    // The type declaration is still the first thing the author needs.
    expect(defs.filter((d) => d.kind === "type").map((d) => d.name)).toEqual(["SnippetCache"]);
  });
});

describe("findExemplar", () => {
  it("does not hand back the most-referenced accessor", async () => {
    const exemplar = await findExemplar(cacheRepo(), "snippet-cache", {
      // No 「キャッシュ」 in the task: the detector now maps that katakana to
      // "cache", which `MakeSnippetCache` also carries — the tie would then be
      // broken by reference count and hide what this test is about.
      task: "snippet の evict を実装する",
    });
    expect(exemplar?.name).not.toBe("size");
    expect(exemplar?.name).toBe("EvictSnippet");
  });

  it("falls back to reference count when the task names nothing in the domain", async () => {
    const exemplar = await findExemplar(cacheRepo(), "snippet-cache", { task: "無関係な依頼" });
    expect(exemplar?.name).toBe("MakeSnippetCache");
  });
});

describe("pickExemplarSibling", () => {
  it("keeps a candidate rather than returning nothing when every sibling is an accessor", () => {
    const picked = pickExemplarSibling(
      [
        { anchor: anchor("a"), name: "size", layer: "src", references: 10 },
        { anchor: anchor("b"), name: "empty", layer: "src", references: 3 },
      ],
      "src",
      "スニペット",
    );
    expect(picked?.name).toBe("size");
  });
});
