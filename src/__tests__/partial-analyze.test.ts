/**
 * analyze({ scope }) — partial / staged execution.
 *
 * A scope restricts the source set to path prefixes and/or skips the
 * domain-detection (Phase 4) or spec-linking (Phase 5) phase. Scoped results
 * carry a `partial` marker so no consumer mistakes them for a canonical full
 * analysis. An empty scope behaves exactly like no scope (no marker).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "../core.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "anatomia-partial-"));
  await mkdir(join(root, "combat"), { recursive: true });
  await mkdir(join(root, "ui"), { recursive: true });
  await mkdir(join(root, "spec"), { recursive: true });
  await writeFile(join(root, "combat", "attack.ts"), "export function attack() { return 1; }\n");
  await writeFile(join(root, "ui", "menu.ts"), "export function menu() { return 2; }\n");
  await writeFile(join(root, "spec", "combat.md"), "# combat\n\n- attack resolves damage\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("analyze scope", () => {
  it("restricts sources to the requested path prefixes and marks the result", async () => {
    const ctx = await analyze(root, { quiet: true, scope: { paths: ["combat"] } });
    expect(ctx.files.map((f) => f.path.replace(/\\/g, "/"))).toEqual([
      expect.stringContaining("combat/attack.ts"),
    ]);
    expect(ctx.functions.map((f) => f.name)).toEqual(["attack"]);
    expect(ctx.partial).toEqual({ paths: ["combat"] });
  });

  it("skips domain detection with scope.domains=false", async () => {
    const ctx = await analyze(root, { quiet: true, scope: { domains: false } });
    expect(ctx.domains).toEqual([]);
    expect(ctx.rules).toEqual([]);
    expect(ctx.partial).toEqual({ domains: false });
    // Other phases still ran.
    expect(ctx.files.length).toBe(2);
  });

  it("skips spec linking with scope.spec=false", async () => {
    const full = await analyze(root, { quiet: true });
    expect(full.specClauses!.length).toBeGreaterThan(0);

    const ctx = await analyze(root, { quiet: true, scope: { spec: false } });
    expect(ctx.specClauses).toEqual([]);
    expect(ctx.links).toEqual([]);
    expect(ctx.partial).toEqual({ spec: false });
  });

  it("treats an empty scope as a full analysis (no partial marker)", async () => {
    const ctx = await analyze(root, { quiet: true, scope: {} });
    expect(ctx.partial).toBeUndefined();
    expect(ctx.files.length).toBe(2);
  });
});
