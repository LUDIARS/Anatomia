/**
 * computeFingerprint({ configDirs }) — config dirs (ontologyDir / specDirs)
 * fold into the fingerprint, so editing an ontology def or an out-of-root spec
 * busts the analysis cache and a re-analyze actually re-runs. Without this, a
 * pure config change (no code edit) would silently serve the stale context.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeFingerprint } from "../cache.js";

let root: string;
let codeRoot: string;
let configDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "anatomia-fp-"));
  codeRoot = join(root, "src");
  configDir = join(root, "spec");
  await mkdir(codeRoot, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(join(codeRoot, "a.cpp"), "int a() { return 0; }\n");
  await writeFile(join(configDir, "S.md"), "# S\n\nclause one.\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("computeFingerprint configDirs", () => {
  it("changes when a config dir is added", async () => {
    const base = await computeFingerprint(codeRoot);
    const withCfg = await computeFingerprint(codeRoot, { configDirs: [configDir] });
    expect(withCfg).not.toBe(base);
  });

  it("changes when a config file's content changes", async () => {
    const before = await computeFingerprint(codeRoot, { configDirs: [configDir] });
    // mtime resolution is coarse; change size too so the stamp differs.
    await writeFile(join(configDir, "S.md"), "# S\n\nclause one. clause two (edited).\n");
    const after = await computeFingerprint(codeRoot, { configDirs: [configDir] });
    expect(after).not.toBe(before);
  });

  it("is stable for the same inputs (deterministic)", async () => {
    const a = await computeFingerprint(codeRoot, { configDirs: [configDir] });
    const b = await computeFingerprint(codeRoot, { configDirs: [configDir] });
    expect(a).toBe(b);
  });
});
