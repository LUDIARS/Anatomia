/**
 * analyze() ontology precedence — explicit pluginDir > ANATOMIA_PLUGIN_DIR >
 * the repo's committed `spec/domains` (then the legacy dirs it replaced).
 * The committed fallback is what
 * lets an ephemeral checkout (a PR review worktree, which has no `.anatomia/`)
 * see the project's semantic domains, and it must load DATA ONLY: the dir is
 * content of the analyzed repo, so an executable `.mjs` def there would run
 * unreviewed author-controlled code inside the analyzer.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "../core.js";
import { resolveCommittedOntologyDir } from "../domains/ontology.js";

const RAN_FLAG = "__anatomiaCommittedOntologyPluginRan";
const globals = globalThis as unknown as Record<string, unknown>;

function domainDef(name: string): string {
  return JSON.stringify({
    name,
    description: `${name} test domain.`,
    presetRules: [],
    templateRules: [],
  });
}

let repo: string;
let explicitDir: string;
let envDir: string;
/** Whatever the developer's shell had, restored after the file's tests. */
let savedPluginDirEnv: string | undefined;

beforeAll(async () => {
  savedPluginDirEnv = process.env["ANATOMIA_PLUGIN_DIR"];
  repo = await mkdtemp(join(tmpdir(), "anatomia-committed-onto-"));
  const ontologyDir = join(repo, "spec", "domains");
  explicitDir = join(repo, "explicit-domains");
  envDir = join(repo, "env-domains");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(ontologyDir, { recursive: true });
  await mkdir(explicitDir, { recursive: true });
  await mkdir(envDir, { recursive: true });
  await writeFile(join(repo, "src", "enemy.cpp"), "int spawn_slime() { return 1; }\n");
  await writeFile(join(ontologyDir, "committed.domain.json"), domainDef("committed-domain"));
  await writeFile(
    join(ontologyDir, "evil.mjs"),
    `globalThis[${JSON.stringify(RAN_FLAG)}] = true;\n` +
      "export default { name: 'committed-executable', description: 'x', presetRules: [], templateRules: [] };\n",
  );
  await writeFile(join(explicitDir, "explicit.json"), domainDef("explicit-domain"));
  await writeFile(join(envDir, "env.json"), domainDef("env-domain"));
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
  if (savedPluginDirEnv === undefined) delete process.env["ANATOMIA_PLUGIN_DIR"];
  else process.env["ANATOMIA_PLUGIN_DIR"] = savedPluginDirEnv;
});

afterEach(() => {
  delete globals[RAN_FLAG];
  delete process.env["ANATOMIA_PLUGIN_DIR"];
});

describe("analyze committed ontology fallback", () => {
  it("loads the repo's committed spec/domains when no plugin dir is configured", async () => {
    delete process.env["ANATOMIA_PLUGIN_DIR"];
    const ctx = await analyze(repo, { quiet: true });
    expect(ctx.domains!.map((d) => d.domain)).toContain("committed-domain");
  });

  it("never executes a committed .mjs def (repo content is untrusted input)", async () => {
    delete process.env["ANATOMIA_PLUGIN_DIR"];
    const ctx = await analyze(repo, { quiet: true });
    expect(ctx.domains!.map((d) => d.domain)).not.toContain("committed-executable");
    expect(globals[RAN_FLAG]).toBeUndefined();
  });

  it("an explicit pluginDir takes precedence over the committed dir", async () => {
    delete process.env["ANATOMIA_PLUGIN_DIR"];
    const ctx = await analyze(repo, { quiet: true, pluginDir: explicitDir });
    const names = ctx.domains!.map((d) => d.domain);
    expect(names).toContain("explicit-domain");
    expect(names).not.toContain("committed-domain");
  });

  it("ANATOMIA_PLUGIN_DIR takes precedence over the committed dir", async () => {
    process.env["ANATOMIA_PLUGIN_DIR"] = envDir;
    const ctx = await analyze(repo, { quiet: true });
    const names = ctx.domains!.map((d) => d.domain);
    expect(names).toContain("env-domain");
    expect(names).not.toContain("committed-domain");
  });

  it("a stray/malformed .json costs only that file, not every domain", async () => {
    // The committed dir is AUTO-DISCOVERED, not curated as a plugin dir, so a
    // non-DomainDef .json sitting next to the defs must not collapse detection
    // to zero domains — that is the very "no target domain" outcome this
    // fallback exists to prevent.
    const strayRepo = await mkdtemp(join(tmpdir(), "anatomia-stray-onto-"));
    try {
      const ontologyDir = join(strayRepo, "spec", "data", "ontology");
      await mkdir(join(strayRepo, "src"), { recursive: true });
      await mkdir(ontologyDir, { recursive: true });
      await writeFile(join(strayRepo, "src", "enemy.cpp"), "int spawn_slime() { return 1; }\n");
      await writeFile(join(ontologyDir, "good.domain.json"), domainDef("surviving-domain"));
      await writeFile(join(ontologyDir, "notes.json"), JSON.stringify({ note: "not a def" }));
      await writeFile(join(ontologyDir, "broken.json"), "{ this is not json");
      await writeFile(join(ontologyDir, "builtins.json"), JSON.stringify({ enabled: 42 }));

      delete process.env["ANATOMIA_PLUGIN_DIR"];
      const ctx = await analyze(strayRepo, { quiet: true });
      expect(ctx.domains!.map((d) => d.domain)).toContain("surviving-domain");
    } finally {
      await rm(strayRepo, { recursive: true, force: true });
    }
  });
});

/**
 * Migration window: repos move to `spec/domains` one PR at a time, so a repo
 * that still carries only a legacy dir must keep its domains — and a repo that
 * carries BOTH must read the new dir, otherwise a migration PR would leave
 * everyday analysis and the Revisor PR gate on different definitions (the exact
 * split this move exists to end).
 */
describe("committed ontology legacy fallback", () => {
  const madeRepos: string[] = [];

  async function repoWith(dirs: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "anatomia-legacy-onto-"));
    madeRepos.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "enemy.cpp"), "int spawn_slime() { return 1; }\n");
    for (const [rel, name] of Object.entries(dirs)) {
      const dir = join(root, ...rel.split("/"));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${name}.domain.json`), domainDef(name));
    }
    return root;
  }

  afterAll(async () => {
    for (const root of madeRepos) await rm(root, { recursive: true, force: true });
  });

  it("still reads a repo that only has the legacy spec/data/ontology", async () => {
    const root = await repoWith({ "spec/data/ontology": "legacy-ontology-domain" });
    const ctx = await analyze(root, { quiet: true });
    expect(ctx.domains!.map((d) => d.domain)).toContain("legacy-ontology-domain");
  });

  it("still reads a repo that only has the legacy .anatomia/domains", async () => {
    const root = await repoWith({ ".anatomia/domains": "legacy-editable-domain" });
    const ctx = await analyze(root, { quiet: true });
    expect(ctx.domains!.map((d) => d.domain)).toContain("legacy-editable-domain");
  });

  it("prefers spec/domains over every legacy dir when both exist", async () => {
    const root = await repoWith({
      "spec/domains": "current-domain",
      "spec/data/ontology": "legacy-ontology-domain",
      ".anatomia/domains": "legacy-editable-domain",
    });
    const names = (await analyze(root, { quiet: true })).domains!.map((d) => d.domain);
    expect(names).toContain("current-domain");
    expect(names).not.toContain("legacy-ontology-domain");
    expect(names).not.toContain("legacy-editable-domain");
  });

  it("does not let a non-directory primary path mask a valid legacy directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-legacy-onto-"));
    madeRepos.push(root);
    await mkdir(join(root, "spec"), { recursive: true });
    await writeFile(join(root, "spec", "domains"), "not a directory\n");
    const legacyDir = join(root, "spec", "data", "ontology");
    await mkdir(legacyDir, { recursive: true });

    expect(resolveCommittedOntologyDir(root)).toBe(legacyDir);
  });
});
