/**
 * The design's own acceptance examples (§12), pinned against fixture repos that
 * mirror the real declarations:
 *
 *   「トランポリンカウンターで〇〇」 → ludellus / uni-jump-trampoline, ranked FIRST,
 *      carrying renderer/mr/games/uni-jump + renderer/lib/jump
 *   「切り絵のデモ」               → figmentum / kirie-transform AND the Pictor
 *      domain that owns the demo, both in the top hits
 *
 * The fixtures stand in for Ludellus / Figmentum / Pictor because those repos are
 * read-only from here and their `content-sources.json` is proposed by this PR
 * rather than committed into them (see spec/feature/domain-map.md).
 */

import { fileURLToPath } from "node:url";
import { cp, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildDomainMapIndex } from "../inverted-index.js";
import { searchDomainMap } from "../search.js";
import { buildProjectDomainMap } from "../sources.js";
import { clearDomainMapMemo, loadProjectDomainMap } from "../bundle.js";
import type { ProjectDomainMap } from "../types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const NOW = () => new Date("2026-09-05T00:00:00.000Z");

async function fixtureMap(id: string): Promise<ProjectDomainMap> {
  return buildProjectDomainMap({ id, rootPath: join(FIXTURES, id) }, { roster: [], now: NOW });
}

async function fixtureIndex() {
  return buildDomainMapIndex([
    await fixtureMap("ludellus"),
    await fixtureMap("figmentum"),
    await fixtureMap("pictor"),
  ]);
}

beforeEach(() => {
  clearDomainMapMemo();
});

describe("searchDomainMap", () => {
  it("ranks the trampoline counter first for the instruction that names it", async () => {
    const hits = searchDomainMap(await fixtureIndex(), "トランポリンカウンターで連続跳躍を数える");
    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0]!;
    expect(top.project).toBe("ludellus");
    expect(top.coreDomain).toBe("uni-jump-trampoline");
    expect(top.paths).toEqual(
      expect.arrayContaining(["renderer/mr/games/uni-jump", "renderer/lib/jump"]),
    );
  });

  it("matches the spaced spelling the catalog actually uses", async () => {
    const hits = searchDomainMap(await fixtureIndex(), "トランポリン カウンター を直す");
    expect(hits[0]!.coreDomain).toBe("uni-jump-trampoline");
  });

  it("surfaces both repos for 「切り絵のデモ」", async () => {
    const hits = searchDomainMap(await fixtureIndex(), "切り絵のデモを実装する", { limit: 6 });
    const pairs = hits.map((hit) => `${hit.project}/${hit.coreDomain ?? hit.name}`);
    expect(pairs).toContain("figmentum/kirie-transform");
    expect(pairs.some((pair) => pair.startsWith("pictor/"))).toBe(true);
  });

  it("returns nothing for an instruction the index cannot place", async () => {
    expect(searchDomainMap(await fixtureIndex(), "量子暗号の鍵配送を実装する")).toEqual([]);
  });

  it("can be narrowed to one project", async () => {
    const hits = searchDomainMap(await fixtureIndex(), "切り絵のデモ", { projects: ["figmentum"] });
    expect(hits.every((hit) => hit.project === "figmentum")).toBe(true);
  });
});

describe("buildProjectDomainMap", () => {
  it("binds declared content to its core domain and its layers", async () => {
    const map = await fixtureMap("ludellus");
    const counter = map.records.find((record) => record.name === "トランポリン カウンター");
    expect(counter).toBeDefined();
    expect(counter!.kind).toBe("content");
    expect(counter!.coreDomain).toBe("uni-jump-trampoline");
    expect(counter!.programDomains).toEqual(expect.arrayContaining(["presentation", "domain"]));
  });

  it("records the service surfaces a spec names", async () => {
    const map = await fixtureMap("ludellus");
    const domain = map.records.find((record) => record.name === "uni-jump-trampoline");
    expect(domain!.links.map((link) => link.name)).toContain("loopback 8790");
  });

  it("falls back to the spec H1 when a repo declares no content source", async () => {
    const map = await fixtureMap("figmentum");
    const names = map.records.map((record) => record.name);
    expect(names).toContain("切り絵変換");
    expect(map.notes.join(" ")).toContain("content-sources.json");
  });

  it("reads frontmatter titles when the declaration asks for them", async () => {
    const map = await fixtureMap("pictor");
    expect(map.records.map((record) => record.name)).toContain("切り絵デモ カタログ");
  });

  it("is stable: the same checkout produces the same source key", async () => {
    const first = await fixtureMap("ludellus");
    const second = await fixtureMap("ludellus");
    expect(second.sourceKey).toBe(first.sourceKey);
    expect(second.records).toEqual(first.records);
  });

  it("invalidates a memoized map when a declared manifest title changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-domain-map-"));
    try {
      await cp(join(FIXTURES, "ludellus"), root, { recursive: true });
      const source = { id: "ludellus", rootPath: root };
      const roster = { codes: [], error: null };
      const first = await loadProjectDomainMap(source, { roster });
      const manifest = join(root, "renderer", "mr", "games", "uni-jump", "manifest.json");
      const raw = await readFile(manifest, "utf8");
      const original = "トランポリン カウンター";
      const replacement = "x".repeat(Buffer.byteLength(original, "utf8"));
      const before = await stat(manifest);
      await writeFile(manifest, raw.replace(original, replacement), "utf8");
      await utimes(manifest, before.atime, before.mtime);

      const second = await loadProjectDomainMap(source, { roster, sourceCheckIntervalMs: 0 });
      expect(second.sourceKey).not.toBe(first.sourceKey);
      expect(second.records.map((record) => record.name)).toContain(replacement);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reuses a warm map until its bounded source-check interval expires", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-domain-map-warm-"));
    try {
      await cp(join(FIXTURES, "ludellus"), root, { recursive: true });
      const source = { id: "ludellus", rootPath: root };
      const roster = { codes: [], error: null };
      let clock = 0;
      const options = { roster, nowMs: () => clock, sourceCheckIntervalMs: 1_000 };
      const first = await loadProjectDomainMap(source, options);
      const manifest = join(root, "renderer", "mr", "games", "uni-jump", "manifest.json");
      await writeFile(
        manifest,
        (await readFile(manifest, "utf8")).replace("トランポリン", "ジャンプ"),
        "utf8",
      );

      clock = 500;
      expect(await loadProjectDomainMap(source, options)).toBe(first);
      clock = 1_001;
      expect((await loadProjectDomainMap(source, options)).sourceKey).not.toBe(first.sourceKey);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("coalesces concurrent cold loads of the same project", async () => {
    const source = { id: "ludellus", rootPath: join(FIXTURES, "ludellus") };
    const roster = { codes: [], error: null };
    const [first, second] = await Promise.all([
      loadProjectDomainMap(source, { roster }),
      loadProjectDomainMap(source, { roster }),
    ]);
    expect(second).toBe(first);
  });

  it("binds overlapping memberships to the most specific path owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-domain-map-owner-"));
    try {
      await mkdir(join(root, "spec", "domains"), { recursive: true });
      await mkdir(join(root, "src", "kirie"), { recursive: true });
      const domain = (name: string, pathPattern: string) => ({
        name,
        description: name,
        role: "semantic",
        presetRules: [],
        templateRules: [],
        membership: [{ pathPattern }],
      });
      await writeFile(
        join(root, "spec", "domains", "a-broad.domain.json"),
        JSON.stringify(domain("broad", "(^|/)src/")),
        "utf8",
      );
      await writeFile(
        join(root, "spec", "domains", "z-specific.domain.json"),
        JSON.stringify(domain("specific", "(^|/)src/kirie/")),
        "utf8",
      );
      await writeFile(
        join(root, "spec", "domains", "content-sources.json"),
        JSON.stringify([{ glob: "src/kirie", nameFrom: "manifest.json:title" }]),
        "utf8",
      );
      await writeFile(
        join(root, "src", "kirie", "manifest.json"),
        JSON.stringify({ title: "Kirie" }),
        "utf8",
      );

      const map = await buildProjectDomainMap({ id: "fixture", rootPath: root }, { roster: [] });
      expect(map.records.find((record) => record.name === "Kirie")?.coreDomain).toBe("specific");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("memoizes roster lookup but rebuilds links after outage recovery", async () => {
    const source = { id: "figmentum", rootPath: join(FIXTURES, "figmentum") };
    let calls = 0;
    const cachedLookup = {
      url: "http://localhost/v1/project-codes",
      fetchImpl: (async () => {
        calls++;
        return new Response(JSON.stringify([{ id: "pictor", name: "Pictor", code: "Pc" }]));
      }) as typeof fetch,
    };
    await loadProjectDomainMap(source, { projectCodes: cachedLookup, rosterCacheMs: 60_000 });
    await loadProjectDomainMap(source, { projectCodes: cachedLookup, rosterCacheMs: 60_000 });
    expect(calls).toBe(1);

    clearDomainMapMemo();
    calls = 0;
    const recoveringLookup = {
      url: "http://localhost/v1/project-codes",
      fetchImpl: (async () => {
        calls++;
        if (calls === 1) throw new Error("offline");
        return new Response(JSON.stringify([{ id: "pictor", name: "Pictor", code: "Pc" }]));
      }) as typeof fetch,
    };
    const unavailable = await loadProjectDomainMap(source, {
      projectCodes: recoveringLookup,
      rosterCacheMs: 0,
    });
    const recovered = await loadProjectDomainMap(source, {
      projectCodes: recoveringLookup,
      rosterCacheMs: 0,
    });
    expect(recovered.rosterKey).not.toBe(unavailable.rosterKey);
    expect(recovered.records.flatMap((record) => record.links).map((link) => link.project))
      .toContain("pictor");
  });
});
