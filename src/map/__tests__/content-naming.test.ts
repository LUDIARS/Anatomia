/**
 * Two ways a repo's content stops reaching the index, pinned against fixtures:
 *
 *   1. It has no name to be found by. `Pictor/demo/*` is nineteen shipped demos
 *      with neither a manifest nor a README, so `nameFrom: "dirname"` reads the
 *      directory name — and hands the entry over to the spec document when one
 *      names the same thing, rather than indexing the demo twice.
 *   2. Its owner swallowed it. A membership naming two documents under
 *      `spec/feature/` used to hint at the whole directory, which made every
 *      document there look like the same content and collapsed the lot into one
 *      record (`q=切り絵` returned Figmentum's domain but not its spec).
 */

import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectContentEntries } from "../content-sources.js";
import { buildProjectDomainMap, pathHintsFromPattern } from "../sources.js";
import type { DomainMapRecord, ProjectDomainMap } from "../types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const NOW = () => new Date("2026-09-05T00:00:00.000Z");

async function fixtureMap(id: string): Promise<ProjectDomainMap> {
  return buildProjectDomainMap({ id, rootPath: join(FIXTURES, id) }, { roster: [], now: NOW });
}

function contents(map: ProjectDomainMap): DomainMapRecord[] {
  return map.records.filter((record) => record.kind === "content");
}

describe("nameFrom: dirname", () => {
  it("names a demo after its directory, separators evened out and nothing translated", async () => {
    const record = contents(await fixtureMap("pictor"))
      .find((entry) => entry.paths.includes("demo/text_effects"));
    expect(record).toBeDefined();
    expect(record!.name).toBe("text effects");
  });

  it("hands the entry to the spec document that names the same demo", async () => {
    const map = await fixtureMap("pictor");
    const named = contents(map).filter((record) => record.name === "影絵デモ — 切り絵バックドロップ");
    // ONE record, not the directory and the document competing for the same demo.
    expect(named).toHaveLength(1);
    expect(named[0]!.paths).toContain("demo/shadow_play");
    expect(named[0]!.spec).toBe("spec/feature/shadow-play-kirie-backdrop.md");
    expect(named[0]!.coreDomain).toBe("samples-and-tools");
  });

  it("keeps the content path when the H1 rule is declared first", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-content-rule-order-"));
    try {
      await mkdir(join(root, "demo", "shadow_play"), { recursive: true });
      await mkdir(join(root, "spec", "feature"), { recursive: true });
      await writeFile(
        join(root, "spec", "feature", "shadow-play-kirie-backdrop.md"),
        "# 影絵デモ — 切り絵バックドロップ\n",
        "utf8",
      );

      expect(await collectContentEntries(root, [
        { glob: "spec/feature/*.md", nameFrom: "h1" },
        { glob: "demo/shadow_play/", nameFrom: "dirname" },
      ])).toEqual([{
        name: "影絵デモ — 切り絵バックドロップ",
        path: "demo/shadow_play",
        spec: "spec/feature/shadow-play-kirie-backdrop.md",
      }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("indexes only what the repo declared, not its neighbours in demo/", async () => {
    const names = contents(await fixtureMap("pictor")).map((record) => record.name);
    expect(names).not.toContain("assets");
    expect(names).not.toContain("shaders");
  });

  it("does not guess a spec when the filename match is ambiguous or has no H1", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-content-spec-match-"));
    try {
      await mkdir(join(root, "demo", "foo"), { recursive: true });
      await mkdir(join(root, "spec", "feature"), { recursive: true });
      await writeFile(join(root, "spec", "feature", "foo-api.md"), "# Foo API\n", "utf8");
      await writeFile(join(root, "spec", "feature", "foo-ui.md"), "# Foo UI\n", "utf8");
      const rules = [{ glob: "demo/foo/", nameFrom: "dirname" as const }];

      expect(await collectContentEntries(root, rules)).toEqual([
        { name: "foo", path: "demo/foo", spec: null },
      ]);

      await writeFile(join(root, "spec", "feature", "foo.md"), "No heading.\n", "utf8");
      expect(await collectContentEntries(root, rules)).toEqual([
        { name: "foo", path: "demo/foo", spec: null },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("membership patterns that name documents", () => {
  it("literalises an alternation into the documents it actually matches", () => {
    expect(pathHintsFromPattern("(^|/)spec/feature/kirie(?:-anim|-transform)\\.md$")).toEqual([
      "spec/feature/kirie-anim.md",
      "spec/feature/kirie-transform.md",
    ]);
    expect(pathHintsFromPattern("(^|/)app/cmd_kirie(?:_anim)?\\.(cpp|h)$")).toEqual([
      "app/cmd_kirie_anim.cpp",
      "app/cmd_kirie_anim.h",
      "app/cmd_kirie.cpp",
      "app/cmd_kirie.h",
    ]);
    expect(pathHintsFromPattern("(^|/)spec/(?:foo|\\d)\\.md$")).toEqual([]);
  });

  it("keeps the prefix of a subtree claim and nothing of a name constraint", () => {
    expect(pathHintsFromPattern("(^|/)src/kirie/(?:.*/)?[^/]+$")).toEqual(["src/kirie"]);
    expect(pathHintsFromPattern("(^|/)renderer/mr/")).toEqual(["renderer/mr"]);
    // `test/` is not owned by the domain: two of its files are.
    expect(pathHintsFromPattern("(^|/)test/uni-jump-[a-z-]+\\.test\\.mjs$")).toEqual([]);
    expect(pathHintsFromPattern("(^|/)spec/tasks/[^/]*visus[^/]*\\.md$")).toEqual([]);
  });

  it("never turns a membership into a path outside the repository", () => {
    expect(pathHintsFromPattern("(^|/)../outside\\.md$")).toEqual([]);
    expect(pathHintsFromPattern("^/absolute/spec\\.md$")).toEqual([]);
    expect(pathHintsFromPattern("(^|/)C:/outside\\.md$")).toEqual([]);
  });
});

describe("content records under one spec/feature directory", () => {
  it("keeps every document its own record instead of collapsing them", async () => {
    const map = await fixtureMap("figmentum");
    const specs = contents(map).map((record) => record.spec);
    expect(specs).toEqual(expect.arrayContaining([
      "spec/feature/kirie-transform.md",
      "spec/feature/kirie-anim.md",
      "spec/feature/sdf-geometry.md",
      "spec/feature/render-output.md",
    ]));
    expect(new Set(specs).size).toBe(specs.length);
  });

  it("binds only the documents the membership names, not their neighbours", async () => {
    const map = await fixtureMap("figmentum");
    const ownerOf = (spec: string) =>
      contents(map).find((record) => record.spec === spec)?.coreDomain ?? null;
    expect(ownerOf("spec/feature/kirie-transform.md")).toBe("kirie-transform");
    expect(ownerOf("spec/feature/kirie-anim.md")).toBe("kirie-transform");
    expect(ownerOf("spec/feature/sdf-geometry.md")).toBeNull();
    expect(ownerOf("spec/feature/render-output.md")).toBeNull();
  });

  it("uses the domain-named document as the canonical spec", async () => {
    const map = await fixtureMap("figmentum");
    const content = contents(map).find((record) => record.name === "kirie");
    expect(content?.paths).toContain("src/kirie");
    expect(content?.spec).toBe("spec/feature/kirie-transform.md");
  });

  it("folds interleaved catalog and spec pairs without cross-group corruption", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-content-dedupe-"));
    try {
      await mkdir(join(root, "spec", "feature"), { recursive: true });
      await mkdir(join(root, "spec", "domains"), { recursive: true });
      await mkdir(join(root, "games", "uni-throw"), { recursive: true });
      await mkdir(join(root, "games", "uni-z-long"), { recursive: true });
      await writeFile(
        join(root, "spec", "domains", "uni-throw.domain.json"),
        JSON.stringify({
          name: "uni-throw",
          description: "投げるあそび。",
          role: "semantic",
          presetRules: [],
          templateRules: [],
          membership: [
            { pathPattern: "(^|/)games/uni-throw/" },
            { pathPattern: "(^|/)spec/feature/uni-throw\\.md$" },
          ],
        }),
        "utf8",
      );
      await writeFile(
        join(root, "spec", "domains", "uni-z-long.domain.json"),
        JSON.stringify({
          name: "uni-z-long",
          description: "長いカタログ名を持つあそび。",
          role: "semantic",
          presetRules: [],
          templateRules: [],
          membership: [
            { pathPattern: "(^|/)games/uni-z-long/" },
            { pathPattern: "(^|/)spec/feature/uni-z-long\\.md$" },
          ],
        }),
        "utf8",
      );
      await writeFile(
        join(root, "spec", "domains", "content-sources.json"),
        JSON.stringify([
          { glob: "games/*", nameFrom: "manifest.json:title" },
          { glob: "spec/feature/*.md", nameFrom: "h1" },
        ]),
        "utf8",
      );
      await writeFile(
        join(root, "games", "uni-throw", "manifest.json"),
        JSON.stringify({ title: "まとあて" }),
        "utf8",
      );
      await writeFile(
        join(root, "games", "uni-z-long", "manifest.json"),
        JSON.stringify({ title: "仕様見出しより長いカタログ表示名" }),
        "utf8",
      );
      await writeFile(
        join(root, "spec", "feature", "uni-throw.md"),
        "# uni-throw — まとあて\n\n的を狙って投げる。\n",
        "utf8",
      );
      await writeFile(
        join(root, "spec", "feature", "uni-z-long.md"),
        "# 短名\n\n短い名前の仕様。\n",
        "utf8",
      );

      const map = await buildProjectDomainMap({ id: "fixture", rootPath: root }, { roster: [] });
      const throwing = contents(map).filter((record) => record.coreDomain === "uni-throw");
      expect(throwing).toHaveLength(1);
      expect(throwing[0]!.name).toBe("まとあて");
      const longNamed = contents(map).filter((record) => record.coreDomain === "uni-z-long");
      expect(longNamed).toHaveLength(1);
      expect(longNamed[0]!.name).toBe("短名");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
