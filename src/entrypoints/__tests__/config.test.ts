/**
 * src/entrypoints/__tests__/config.test.ts — `.anatomia/entrypoints.json`.
 */

import { afterEach, describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultEntryPointConfig,
  computeEntryPointConfigRevision,
  isTestPath,
  loadEntryPointConfig,
  normalizeEntryPointConfig,
  ruleMatches,
} from "../config.js";

const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...temporaryRoots].map((root) => rm(root, { recursive: true, force: true })));
  temporaryRoots.clear();
});

async function repoWithConfig(text: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "anatomia-entrypoints-"));
  temporaryRoots.add(root);
  await mkdir(join(root, ".anatomia"), { recursive: true });
  await writeFile(join(root, ".anatomia", "entrypoints.json"), text, "utf8");
  return root;
}

describe("loadEntryPointConfig", () => {
  it("falls back to conventions-only defaults when the file is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-entrypoints-"));
    temporaryRoots.add(root);
    const loaded = await loadEntryPointConfig(root);
    expect(loaded.config).toEqual(defaultEntryPointConfig());
    expect(loaded.diagnostics).toEqual([]);
  });

  it("reports an invalid config instead of ignoring it", async () => {
    const root = await repoWithConfig('{ "include": [{}] }');
    const loaded = await loadEntryPointConfig(root);
    expect(loaded.config).toEqual(defaultEntryPointConfig());
    expect(loaded.diagnostics).toHaveLength(1);
    expect(loaded.diagnostics[0]!.kind).toBe("config-invalid");
  });

  it("reports unparsable JSON the same way", async () => {
    const root = await repoWithConfig("{not json");
    const loaded = await loadEntryPointConfig(root);
    expect(loaded.diagnostics[0]!.kind).toBe("config-invalid");
  });

  it("normalizes and sorts a valid config", async () => {
    const root = await repoWithConfig(JSON.stringify({
      includeTests: true,
      include: [{ namePattern: "^handle" }, { pathGlob: "src/a/**", class: "http-route" }],
      traversal: { edgeKinds: ["depends", "calls"], maxDepth: 8 },
    }));
    const { config } = await loadEntryPointConfig(root);
    expect(config.includeTests).toBe(true);
    expect(config.include.map((rule) => rule.pathGlob ?? rule.namePattern)).toEqual(["^handle", "src/a/**"]);
    expect(config.traversal).toEqual({ edgeKinds: ["calls", "depends"], maxDepth: 8 });
  });

  it("changes the config revision when only entrypoints.json changes", async () => {
    const root = await repoWithConfig('{"includeTests":false}');
    try {
      const before = await computeEntryPointConfigRevision(root);
      await writeFile(join(root, ".anatomia", "entrypoints.json"), '{"includeTests":true}', "utf8");
      expect(await computeEntryPointConfigRevision(root)).not.toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("normalizeEntryPointConfig", () => {
  it("rejects a rule with no selector", () => {
    expect(() => normalizeEntryPointConfig({ include: [{ class: "process" }] })).toThrow(/needs symbol/);
  });

  it("rejects an unusable namePattern at load time", () => {
    expect(() => normalizeEntryPointConfig({ include: [{ namePattern: "([" }] })).toThrow();
  });

  it("rejects a non-positive maxDepth", () => {
    expect(() => normalizeEntryPointConfig({ traversal: { maxDepth: 0 } })).toThrow(/maxDepth/);
  });

  it("rejects misspelled fields instead of silently ignoring them", () => {
    expect(() => normalizeEntryPointConfig({ includeTest: true })).toThrow(/unknown field/);
    expect(() => normalizeEntryPointConfig({ include: [{ namePattern: "^run", clas: "process" }] }))
      .toThrow(/unknown field/);
    expect(() => normalizeEntryPointConfig({ traversal: { maxdepth: 1 } })).toThrow(/unknown field/);
  });
});

describe("ruleMatches", () => {
  const symbol = { anchor: "anchor-1", name: "runCli", path: "src/adapters/cli.ts" };

  it("matches a path#name symbol reference and a raw anchor", () => {
    expect(ruleMatches({ symbol: "src/adapters/cli.ts#runCli" }, symbol)).toBe(true);
    expect(ruleMatches({ symbol: "anchor-1" }, symbol)).toBe(true);
    expect(ruleMatches({ symbol: "src/adapters/cli.ts#other" }, symbol)).toBe(false);
  });

  it("treats ** as crossing separators and * as not", () => {
    expect(ruleMatches({ pathGlob: "src/**" }, symbol)).toBe(true);
    expect(ruleMatches({ pathGlob: "src/*" }, symbol)).toBe(false);
  });

  it("ANDs every field the rule sets", () => {
    expect(ruleMatches({ pathGlob: "src/**", namePattern: "^run" }, symbol)).toBe(true);
    expect(ruleMatches({ pathGlob: "src/**", namePattern: "^nope" }, symbol)).toBe(false);
  });
});

describe("isTestPath", () => {
  it("recognises the test conventions the default scope excludes", () => {
    expect(isTestPath("src/a/__tests__/x.ts")).toBe(true);
    expect(isTestPath("tests/x.ts")).toBe(true);
    expect(isTestPath("src/a.test.ts")).toBe(true);
    expect(isTestPath("src/a.spec.tsx")).toBe(true);
    expect(isTestPath("src/attestation.ts")).toBe(false);
  });
});
