/**
 * Low-memory analyze — bodyAst release + per-file disk cache (5a/5b).
 *
 * By default analyze() consumes each file's detached AST mirrors in phase 1
 * (edge info + template matches) and releases them, so a large repo's peak
 * heap is bounded by one file. The graph and domain detection must be
 * IDENTICAL to the retained-AST path. With a fileCache, a fresh process
 * (no priorFiles) reuses unchanged files from disk without re-parsing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "../core.js";
import type { CacheEvent } from "../cache/transcript.js";
import { FileAnalysisDiskCache } from "../project/file-cache.js";

let root: string;
let cacheDir: string;

// b() calls a() so the graph has a cross-function edge to compare;
// mutate() matches the builtin transition-guard-example forbidden template.
const SRC_A = "int a(int x) { return x + 1; }\n";
const SRC_B = "int a(int); int b(int y) { return a(y) * 2; }\n";
const SRC_MUTATE = "struct S { void mutate(int s); };\nvoid bad(S skill, int state) { skill.mutate(state); }\n";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "anatomia-lowmem-"));
  cacheDir = await mkdtemp(join(tmpdir(), "anatomia-lowmem-cache-"));
  await writeFile(join(root, "a.cpp"), SRC_A);
  await writeFile(join(root, "b.cpp"), SRC_B);
  await writeFile(join(root, "mutate.cpp"), SRC_MUTATE);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
});

const edgeSummary = (ctx: Awaited<ReturnType<typeof analyze>>): string[] =>
  ctx.graph.raw.edges.map((e) => `${e.from}->${e.to}:${e.kind}`).sort();

describe("low-memory analyze (AST release)", () => {
  it("releases every bodyAst by default and retains edgeInfo instead", async () => {
    const ctx = await analyze(root, { quiet: true });
    expect(ctx.functions.length).toBeGreaterThan(0);
    for (const fn of ctx.functions) {
      expect(fn.bodyAst).toBeUndefined();
      expect(fn.edgeInfo !== undefined).toBe(true);
    }
  });

  it("keeps bodyAst alive with retainAst: true", async () => {
    const ctx = await analyze(root, { quiet: true, retainAst: true });
    for (const fn of ctx.functions) expect(fn.bodyAst).toBeDefined();
  });

  it("builds the same graph and policy violations as the retained path", async () => {
    const released = await analyze(root, { quiet: true, builtins: "all" });
    const retained = await analyze(root, { quiet: true, builtins: "all", retainAst: true });

    expect(edgeSummary(released)).toEqual(edgeSummary(retained));

    // The builtin transition-guard-example template ($SKILL.mutate($STATE))
    // must still flag mutate.cpp — its match was recorded before AST release.
    const violationsOf = (ctx: typeof released): string[] =>
      (ctx.policyResults ?? [])
        .flatMap((r) => r.violations)
        .map((v) => v.ruleId + "|" + v.evidence)
        .sort();
    const releasedTemplateViolations = violationsOf(released)
      .filter((v) => v.includes("no-direct-mutate"));
    expect(releasedTemplateViolations.length).toBeGreaterThan(0);
    expect(violationsOf(released)).toEqual(violationsOf(retained));
  });

  it("records template match results on the released functions", async () => {
    const ctx = await analyze(root, { quiet: true, builtins: "all" });
    const bad = ctx.functions.find((fn) => fn.name === "bad")!;
    expect(bad.templateMatches).toBeDefined();
    const entries = Object.entries(bad.templateMatches!);
    expect(entries.some(([, v]) => v !== null)).toBe(true);
    // A non-matching function records the checked-but-unmatched nulls.
    const a = ctx.functions.find((fn) => fn.name === "a" && fn.edgeInfo)!;
    expect(Object.values(a.templateMatches ?? {}).every((v) => v === null)).toBe(true);
  });
});

describe("per-file disk cache (fileCache)", () => {
  it("serves unchanged files from disk in a fresh process (no priorFiles)", async () => {
    const cache = new FileAnalysisDiskCache(cacheDir);
    const first = await analyze(root, { quiet: true, fileCache: cache });

    // Simulate a fresh process: same cache, NO priorFiles.
    const events: CacheEvent[] = [];
    const second = await analyze(root, {
      quiet: true,
      fileCache: cache,
      transcript: { record: (e) => void events.push(e), flush: async () => {} },
      session: "test",
    });

    // Every file must be a per-file cache hit (nothing re-parsed).
    const perfile = events.filter(
      (e): e is Extract<CacheEvent, { kind: "get" }> => e.kind === "get" && e.ns === "perfile",
    );
    expect(perfile.length).toBe(second.files.length);
    expect(perfile.every((e) => e.hit)).toBe(true);

    // The disk round-trip must preserve identity + derived results.
    expect(edgeSummary(second)).toEqual(edgeSummary(first));
    const ids = (ctx: typeof first): string[] =>
      ctx.functions.map((fn) => String(fn.id)).sort();
    expect(ids(second)).toEqual(ids(first));
  });

  it("misses (and re-parses) when a file's content changed", async () => {
    const cache = new FileAnalysisDiskCache(cacheDir);
    await analyze(root, { quiet: true, fileCache: cache });
    await writeFile(join(root, "a.cpp"), "int a(int x) { return x + 42; }\n");

    const events: CacheEvent[] = [];
    const second = await analyze(root, {
      quiet: true,
      fileCache: cache,
      transcript: { record: (e) => void events.push(e), flush: async () => {} },
      session: "test",
    });
    const misses = events.filter(
      (e): e is Extract<CacheEvent, { kind: "get" }> => e.kind === "get" && e.ns === "perfile" && !e.hit,
    );
    expect(misses.length).toBe(1);
    // The re-parsed file still lands fully analyzed (released + edge info).
    const a = second.files.find((f) => f.path.endsWith("a.cpp"))!;
    expect(a.functions[0]!.bodyAst).toBeUndefined();
    expect(a.functions[0]!.edgeInfo !== undefined).toBe(true);
  });
});
