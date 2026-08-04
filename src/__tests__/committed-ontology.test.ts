/**
 * analyze() ontology precedence — explicit pluginDir > ANATOMIA_PLUGIN_DIR >
 * the repo's committed `spec/data/ontology`. The committed fallback is what
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
  const ontologyDir = join(repo, "spec", "data", "ontology");
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
  it("loads the repo's committed spec/data/ontology when no plugin dir is configured", async () => {
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

      delete process.env["ANATOMIA_PLUGIN_DIR"];
      const ctx = await analyze(strayRepo, { quiet: true });
      expect(ctx.domains!.map((d) => d.domain)).toContain("surviving-domain");
    } finally {
      await rm(strayRepo, { recursive: true, force: true });
    }
  });
});
