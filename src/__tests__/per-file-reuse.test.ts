/**
 * analyze({ priorFiles }) — per-file analysis reuse.
 *
 * A partial edit should only re-parse the files that changed. analyze() takes a
 * map of prior FileNodes keyed by path; a file whose source SHA-256 still
 * matches its prior `contentHash` is reused verbatim (same FileNode object,
 * detached bodyAst and all), so parse/extract is skipped for it. The project
 * fingerprint already handles the all-unchanged case (project/cache.ts); this
 * covers the partial-change fast path that fingerprint alone would full-rebuild.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "../core.js";
import type { FileNode } from "../types.js";

let root: string;

const priorMap = (files: FileNode[]): Map<string, FileNode> =>
  new Map(files.map((f) => [f.path, f]));
const byBase = (files: FileNode[], base: string): FileNode =>
  files.find((f) => f.path.endsWith(base))!;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "anatomia-perfile-"));
  await writeFile(join(root, "a.ts"), "export function a() { return 1; }\n");
  await writeFile(join(root, "b.ts"), "export function b() { return 2; }\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("analyze per-file reuse", () => {
  it("stamps each FileNode with a content hash", async () => {
    const ctx = await analyze(root, { quiet: true });
    for (const f of ctx.files) {
      expect(typeof f.contentHash).toBe("string");
      expect(f.contentHash!.length).toBe(64); // sha256 hex
    }
  });

  it("reuses unchanged files (same object) and re-parses changed ones", async () => {
    const first = await analyze(root, { quiet: true });
    const priorA = byBase(first.files, "a.ts");
    const priorB = byBase(first.files, "b.ts");

    // Change only b.ts; a.ts is byte-identical.
    await writeFile(join(root, "b.ts"), "export function b() { return 99; }\n");

    const second = await analyze(root, { quiet: true, priorFiles: priorMap(first.files) });
    const nextA = byBase(second.files, "a.ts");
    const nextB = byBase(second.files, "b.ts");

    // a.ts unchanged → the very same FileNode object is reused (parse skipped).
    expect(nextA).toBe(priorA);
    // b.ts changed → a fresh FileNode, different content hash.
    expect(nextB).not.toBe(priorB);
    expect(nextB.contentHash).not.toBe(priorB.contentHash);
  });

  it("re-parses everything when no prior map is supplied", async () => {
    const first = await analyze(root, { quiet: true });
    const second = await analyze(root, { quiet: true }); // no priorFiles
    expect(byBase(second.files, "a.ts")).not.toBe(byBase(first.files, "a.ts"));
  });

  it("ignores a prior entry whose hash no longer matches", async () => {
    const first = await analyze(root, { quiet: true });
    await writeFile(join(root, "a.ts"), "export function a() { return 7; }\n");
    const second = await analyze(root, { quiet: true, priorFiles: priorMap(first.files) });
    const nextA = byBase(second.files, "a.ts");
    // Stale prior for a.ts must NOT be reused; the new node carries new content.
    expect(nextA).not.toBe(byBase(first.files, "a.ts"));
    expect(nextA.functions[0]!.id).toBeTruthy();
  });
});
