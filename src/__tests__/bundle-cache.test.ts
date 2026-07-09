/**
 * buildContextBundle cache: an injected bundle cache makes a repeated
 * (task, ctx) request return the SAME ContextBundle object, and any change to
 * the request or the code identity recomputes a fresh one.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze, buildContextBundle } from "../core.js";
import { createMemoryStore } from "../cache/store.js";
import type { AnalysisContext } from "../core.js";
import type { ContextBundle, SpecClause } from "../types.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "anatomia-bundlecache-"));
  await writeFile(join(root, "a.ts"), "export function spawn() { return 1; }\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("buildContextBundle cache", () => {
  it("reuses the same bundle for a repeated (task, code) request", async () => {
    const cache = createMemoryStore<ContextBundle>();
    const ctx = await analyze(root, { quiet: true });
    const b1 = await buildContextBundle(ctx, { task: "add a spawn" }, cache);
    const b2 = await buildContextBundle(ctx, { task: "add a spawn" }, cache);
    expect(b2).toBe(b1); // cache hit → same object
  });

  it("recomputes for a different task", async () => {
    const cache = createMemoryStore<ContextBundle>();
    const ctx = await analyze(root, { quiet: true });
    const b1 = await buildContextBundle(ctx, { task: "add a spawn" }, cache);
    const b2 = await buildContextBundle(ctx, { task: "remove a spawn" }, cache);
    expect(b2).not.toBe(b1);
  });

  it("recomputes when the code identity changes (structural edit)", async () => {
    const cache = createMemoryStore<ContextBundle>();
    const ctx1 = await analyze(root, { quiet: true });
    const b1 = await buildContextBundle(ctx1, { task: "add a spawn" }, cache);

    // Structural change (new function), not a mere literal — the normalized hash
    // intentionally ignores literal values, so add structure to move the key.
    await writeFile(join(root, "a.ts"), "export function spawn() { return 1; }\nexport function despawn() { return spawn(); }\n");
    const ctx2 = await analyze(root, { quiet: true });
    const b2 = await buildContextBundle(ctx2, { task: "add a spawn" }, cache);
    expect(b2).not.toBe(b1);
  });

  it("stays deterministic in content across the cache boundary", async () => {
    const ctx = await analyze(root, { quiet: true });
    const uncached = await buildContextBundle(ctx, { task: "x" }, createMemoryStore<ContextBundle>());
    const cache = createMemoryStore<ContextBundle>();
    await buildContextBundle(ctx, { task: "x" }, cache); // prime
    const hit = await buildContextBundle(ctx, { task: "x" }, cache);
    expect(JSON.stringify(hit)).toBe(JSON.stringify(uncached));
  });

  it("keeps relevant spec clauses when applying the byte cap", async () => {
    const clauses: SpecClause[] = [
      { id: "a", sourceFile: "spec.md", heading: "Render", text: "x".repeat(700), embedding: null },
      { id: "b", sourceFile: "spec.md", heading: "Billing", text: "y".repeat(700), embedding: null },
      { id: "z", sourceFile: "spec.md", heading: "Session", text: "lock release", embedding: null },
    ];
    const ctx: AnalysisContext = {
      repoPath: "/repo",
      graph: {} as AnalysisContext["graph"],
      files: [],
      functions: [],
      specClauses: clauses,
    };
    const bundle = await buildContextBundle(
      ctx,
      { task: "session lock release", maxBundleBytes: 700 },
      createMemoryStore<ContextBundle>(),
    );
    expect(bundle.specClauses.map((c) => c.id)).toEqual(["z"]);
    expect(Buffer.byteLength(JSON.stringify(bundle), "utf8")).toBeLessThanOrEqual(700);
  });
});
