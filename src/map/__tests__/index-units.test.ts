/**
 * Unit-level behaviour the acceptance tests depend on: spelling normalisation,
 * link extraction, the roster parser, and the plan hints a search turns into.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aliasKeys, indexTokens, normalizeAlias, pathTokens, queryBigramPairs } from "../aliases.js";
import { loadContentSources } from "../content-sources.js";
import { extractLinks, httpSurfaces } from "../links.js";
import { parseProjectCodes, fetchProjectCodes, resolveProjectCodesUrl } from "../project-codes.js";
import { pathHintFromPattern, layersForPaths } from "../sources.js";
import { fromHits } from "../../supply/plan/hints.js";
import type { DomainMapHit } from "../types.js";

describe("normalizeAlias", () => {
  it("folds the spellings of one product name onto one key", () => {
    const key = normalizeAlias("トランポリン カウンター");
    expect(normalizeAlias("トランポリンカウンター")).toBe(key);
    expect(normalizeAlias("ﾄﾗﾝﾎﾟﾘﾝｶｳﾝﾀｰ")).toBe(key);
    expect(normalizeAlias("トランポリンカウンタ")).toBe(key);
    expect(normalizeAlias("とらんぽりん　かうんたー")).toBe(key);
  });

  it("folds full-width latin and case", () => {
    expect(normalizeAlias("Ｕｎｉ-Ｊｕｍｐ")).toBe(normalizeAlias("uni jump"));
  });
});

describe("loadContentSources", () => {
  it("reports an invalid row without echoing repository-owned values", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-content-sources-"));
    try {
      await mkdir(join(root, "spec", "domains"), { recursive: true });
      await writeFile(
        join(root, "spec", "domains", "content-sources.json"),
        JSON.stringify([{ glob: 1, extra: "sensitive-field-value" }]),
        "utf8",
      );
      const result = await loadContentSources(root);
      expect(result.error).toContain("1 件目");
      expect(result.error).not.toContain("sensitive-field-value");

      await writeFile(
        join(root, "spec", "domains", "content-sources.json"),
        JSON.stringify([{ glob: "../outside/*", nameFrom: "h1" }]),
        "utf8",
      );
      expect((await loadContentSources(root)).error).toContain("1 件目");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("aliasKeys", () => {
  it("keeps both the whole name and its halves", () => {
    expect(aliasKeys("uni-jump — トランポリン カウンター")).toEqual(
      expect.arrayContaining(["unijump", "とらんぽりんかうんた"]),
    );
  });

  it("drops one-character fragments that would match everything", () => {
    expect(aliasKeys("a")).toEqual([]);
  });
});

describe("indexTokens", () => {
  it("emits one token per bigram, kana folded, plus the loanword's romaji", () => {
    const tokens = indexTokens("プロジェクトのデータ");
    // 「のデ」 and 「ので」 are the same three characters: counting both let a
    // katakana word score twice for one occurrence.
    expect(tokens).toContain("ので");
    expect(tokens).not.toContain("のデ");
    expect(indexTokens("デモ")).toContain("demo");
  });

  it("folds the katakana of a record onto the hiragana of a query", () => {
    expect(indexTokens("カウンター")).toEqual(expect.arrayContaining(indexTokens("かうんたー")));
  });
});

describe("queryBigramPairs", () => {
  it("pairs adjacent bigrams of a query, boilerplate stripped", () => {
    const phrases = queryBigramPairs("切り絵のデモを実装する")
      .map(([first, second]) => `${first}${second.slice(1)}`);
    expect(phrases).toContain("切り絵");
    // 「実装する」 is the act, not the subject: it must not become phrase evidence.
    expect(phrases.some((phrase) => phrase.includes("実"))).toBe(false);
  });

  it("has nothing to pair in a run too short to hold a phrase", () => {
    expect(queryBigramPairs("デモ")).toEqual([]);
  });
});

describe("pathTokens", () => {
  it("indexes each segment and its words", () => {
    expect(pathTokens("renderer/mr/games/uni-jump")).toEqual(
      expect.arrayContaining(["renderer", "games", "uni-jump", "uni", "jump"]),
    );
  });
});

describe("pathHintFromPattern", () => {
  it("keeps the literal prefix of a membership regex", () => {
    expect(pathHintFromPattern("(^|/)renderer/mr/games/uni-jump/")).toBe("renderer/mr/games/uni-jump");
    expect(pathHintFromPattern("(^|/)src/kirie/(?:.*/)?[^/]+$")).toBe("src/kirie");
    expect(pathHintFromPattern("(^|/)spec/feature/uni-jump\\.md$")).toBe("spec/feature/uni-jump.md");
  });

  it("returns null when nothing literal survives", () => {
    expect(pathHintFromPattern("[^/]+$")).toBeNull();
  });
});

describe("layersForPaths", () => {
  it("matches a layer glob against a directory the domain owns", () => {
    const config = {
      layers: [
        { glob: "renderer/mr/games/uni-jump/*", layer: "presentation" },
        { glob: "server/*", layer: "infrastructure" },
      ],
      mergeCouplingThreshold: 1,
    };
    expect(layersForPaths(config, ["renderer/mr/games/uni-jump"])).toEqual(["presentation"]);
    expect(layersForPaths(config, ["docs"])).toEqual([]);
  });
});

describe("httpSurfaces", () => {
  it("finds loopback ports and api routes", () => {
    expect(httpSurfaces("preview は loopback 8790、API は /api/jump/count を叩く")).toEqual([
      "loopback 8790",
      "/api/jump/count",
    ]);
  });
});

describe("extractLinks", () => {
  const roster = [
    { id: "interpres", name: "Interpres", code: "Ip" },
    { id: "ludellus", name: "Ludellus", code: "Lw" },
  ];

  it("links a named project and never the record's own", () => {
    const links = extractLinks("Interpres のジャンプ検知を Ludellus が使う", roster, "ludellus");
    expect(links.map((link) => link.project)).toEqual(["interpres"]);
  });

  it("requires a short code to stand alone", () => {
    expect(extractLinks("Zip 圧縮のみ", roster, "ludellus")).toEqual([]);
    expect(extractLinks("(Ip) 経由", roster, "ludellus").map((link) => link.project)).toEqual([
      "interpres",
    ]);
  });
});

describe("parseProjectCodes", () => {
  it("accepts the bare array and the enveloped form", () => {
    expect(parseProjectCodes([{ name: "Interpres", code: "Ip" }])).toEqual([
      { id: "interpres", name: "Interpres", code: "Ip" },
    ]);
    expect(parseProjectCodes({ projects: [{ id: "an", name: "Anatomia", short: "An" }] })).toEqual([
      { id: "an", name: "Anatomia", code: "An" },
    ]);
  });

  it("ignores malformed roster rows without throwing", () => {
    expect(parseProjectCodes([null, 1, "x", [], { name: " Valid ", code: " V " }]))
      .toEqual([{ id: "valid", name: "Valid", code: "V" }]);
  });
});

describe("fetchProjectCodes", () => {
  it("degrades to an empty roster with a reason when Concordia is down", async () => {
    const result = await fetchProjectCodes({
      url: "http://localhost/v1/project-codes",
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(result.codes).toEqual([]);
    expect(result.error).toBe("project-codes request failed (Error)");
  });

  it("takes the Concordia base URL from runtime configuration", () => {
    expect(resolveProjectCodesUrl({ env: { CONCORDIA_URL: "http://localhost:54321/base" } }))
      .toBe("http://localhost:54321/v1/project-codes");
    expect(resolveProjectCodesUrl({ env: {} })).toBeNull();
  });
});

describe("plan hints", () => {
  const hit = (project: string, coreDomain: string, score = 1): DomainMapHit => ({
    project,
    kind: "content",
    name: coreDomain,
    aliases: [],
    coreDomain,
    programDomains: [],
    paths: [],
    spec: null,
    links: [],
    description: "",
    score,
    matched: [],
  });

  it("turns hits into project and domain candidates, best first", () => {
    const hints = fromHits("t", [hit("ludellus", "uni-jump-trampoline"), hit("interpres", "jump")]);
    expect(hints.projects).toEqual(["ludellus", "interpres"]);
    expect(hints.domainHints).toEqual(["uni-jump-trampoline", "jump"]);
    expect(hints.targets).toEqual([
      { project: "ludellus", domain: "uni-jump-trampoline" },
      { project: "interpres", domain: "jump" },
    ]);
    expect(hints.questions).toEqual([]);
  });

  it("keeps a domain hint associated with the project that produced it", () => {
    const hints = fromHits("t", [
      hit("ludellus", "shared-domain", 10),
      hit("another-repo", "shared-domain", 0.1),
    ]);
    expect(hints.projects).toEqual(["ludellus"]);
    expect(hints.targets).toEqual([{ project: "ludellus", domain: "shared-domain" }]);
  });

  it("drops a project whose best hit is noise beside an exact name match", () => {
    const hints = fromHits("t", [
      hit("ludellus", "uni-jump-trampoline", 256),
      hit("concordia", "director-patrol", 2),
    ]);
    expect(hints.projects).toEqual(["ludellus"]);
  });

  it("keeps both repos when the hits are close, as in the cross-repo case", () => {
    const hints = fromHits("t", [
      hit("pictor", "samples-and-tools", 11.3),
      hit("figmentum", "kirie-transform", 0.94),
    ]);
    expect(hints.projects).toEqual(["pictor", "figmentum"]);
  });

  it("turns a zero-hit search into the plan's question", () => {
    const hints = fromHits("量子暗号を実装する", []);
    expect(hints.projects).toEqual([]);
    expect(hints.questions[0]).toContain("索引に無い");
  });
});
