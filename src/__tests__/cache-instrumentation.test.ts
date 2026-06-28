/**
 * Cache instrumentation: analyze() records per-file hit/miss to an injected
 * transcript (ns "perfile"), and the stats aggregator counts only LLM/embedding
 * namespaces toward "calls saved" while still reporting the structural caches by
 * namespace.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "../core.js";
import type { FileNode } from "../types.js";
import type { CacheEvent, CacheTranscript } from "../cache/transcript.js";
import { aggregate } from "../cache/stats.js";

function capturing(): { transcript: CacheTranscript; events: CacheEvent[] } {
  const events: CacheEvent[] = [];
  return { events, transcript: { record: (e) => events.push(e), flush: async () => {} } };
}

describe("analyze per-file transcript", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "anatomia-instr-"));
    await writeFile(join(root, "a.ts"), "export function a() { return 1; }\n");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("records a perfile miss cold and a hit when reused", async () => {
    const cold = capturing();
    const first = await analyze(root, { quiet: true, transcript: cold.transcript, session: "s" });
    const coldPerfile = cold.events.filter((e) => e.kind === "get" && e.ns === "perfile");
    expect(coldPerfile.length).toBe(first.files.length);
    expect(coldPerfile.every((e) => e.kind === "get" && e.hit === false)).toBe(true);

    const warm = capturing();
    const priorFiles: Map<string, FileNode> = new Map(first.files.map((f) => [f.path, f]));
    await analyze(root, { quiet: true, transcript: warm.transcript, session: "s", priorFiles });
    const warmPerfile = warm.events.filter((e) => e.kind === "get" && e.ns === "perfile");
    expect(warmPerfile.every((e) => e.kind === "get" && e.hit === true)).toBe(true);
  });

  it("records nothing when no transcript is supplied", async () => {
    // Smoke: analyze without transcript must not throw.
    const ctx = await analyze(root, { quiet: true });
    expect(ctx.files.length).toBeGreaterThan(0);
  });
});

describe("stats namespace accounting", () => {
  it("counts only LLM/embedding hits toward calls saved; reports all namespaces", () => {
    const ev = (ns: string, hit: boolean): CacheEvent => ({
      kind: "get", ts: 0, session: "s", ns, hit, key: `${ns}-${hit}`,
    });
    const events: CacheEvent[] = [
      ev("perfile", true), ev("perfile", true), // structural hits (no API saved)
      ev("graph", true),
      ev("detection", false),
      ev("card", true), ev("card", false),      // 1 LLM hit
      ev("embedding", true),                      // 1 embedding hit
    ];
    const r = aggregate(events);
    // All namespaces present.
    expect(Object.keys(r.byNamespace).sort()).toEqual(["card", "detection", "embedding", "graph", "perfile"]);
    // Global counts every get.
    expect(r.global.gets).toBe(7);
    expect(r.global.hits).toBe(5);
    // calls saved = LLM/embedding hits only (card 1 + embedding 1), NOT the 3
    // structural hits.
    expect(r.estimatedCallsSaved).toBe(2);
  });
});
