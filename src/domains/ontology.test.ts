/**
 * T18 — Tests for the domain-ontology plugin loader (ontology.ts).
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadOntology,
  BUILTIN_DOMAINS,
  BUILTIN_SELECTION_FILE,
  DEFAULT_BUILTIN_SELECTION,
  resolveBuiltinSelection,
} from "./ontology.js";

describe("T18 BUILTIN_DOMAINS", () => {
  it("ships at least two builtin policies", () => {
    expect(BUILTIN_DOMAINS.length).toBeGreaterThanOrEqual(2);
    expect(BUILTIN_DOMAINS.every((domain) => domain.role === "policy")).toBe(true);
    const names = BUILTIN_DOMAINS.map((m) => m.name);
    expect(names).toContain("transition-guard-example");
    expect(names).not.toContain("state-machine");
    expect(names).toContain("hot-path-processor");
  });

  it("uses the neutral identity for the transition-guard example rules", () => {
    const example = BUILTIN_DOMAINS.find((domain) => domain.name === "transition-guard-example");
    expect(example?.templateRules.map((rule) => rule.id))
      .toEqual(["no-direct-mutate"]);
    expect(example?.presetRules).toEqual([
      { preset: "noCycle", params: { scopePattern: "Transition$" } },
    ]);
  });
});

describe("T18 loadOntology", () => {
  it("applies no builtins by default — they are examples, not agreed rules", async () => {
    delete process.env["ANATOMIA_PLUGIN_DIR"];
    delete process.env["ANATOMIA_BUILTIN_DOMAINS"];
    const onto = await loadOntology();
    expect(onto.domains.has("transition-guard-example")).toBe(false);
    expect(onto.domains.has("hot-path-processor")).toBe(false);
    expect(onto.domains.size).toBe(0);
  });

  let tmp: string | null = null;
  afterEach(async () => {
    if (tmp) {
      await rm(tmp, { recursive: true, force: true });
      tmp = null;
    }
    delete process.env["ANATOMIA_PLUGIN_DIR"];
    delete process.env["ANATOMIA_BUILTIN_DOMAINS"];
  });

  it("loads a .json domain def from a plugin dir", async () => {
    tmp = await mkdtemp(join(tmpdir(), "anatomia-onto-"));
    const def = {
      name: "custom-mech",
      description: "A plugin domain.",
      presetRules: [{ preset: "noCycle", params: {} }],
      templateRules: [],
    };
    await writeFile(join(tmp, "custom.json"), JSON.stringify(def), "utf8");
    const onto = await loadOntology(tmp);
    expect(onto.domains.has("custom-mech")).toBe(true);
    // ...and nothing the repo did not ask for.
    expect(onto.domains.has("transition-guard-example")).toBe(false);
  });

  it("rejects an explicit plugin path that is not a readable directory", async () => {
    tmp = await mkdtemp(join(tmpdir(), "anatomia-onto-"));
    const file = join(tmp, "not-a-directory.json");
    await writeFile(file, "{}", "utf8");
    await expect(loadOntology(file, { builtins: "none" }))
      .rejects.toThrow(/unable to read ontology directory/);
  });

  it("rejects a missing explicit plugin directory instead of loading an empty ontology", async () => {
    tmp = await mkdtemp(join(tmpdir(), "anatomia-onto-"));
    const missing = join(tmp, "missing");
    await expect(loadOntology(missing, { builtins: "none" }))
      .rejects.toThrow(/unable to read ontology directory/);
  });

  it("rejects a non-file ontology entry instead of following it", async () => {
    tmp = await mkdtemp(join(tmpdir(), "anatomia-onto-"));
    await mkdir(join(tmp, "not-a-definition.json"));
    await expect(loadOntology(tmp, { builtins: "none" }))
      .rejects.toThrow(/regular files/);
  });

  it("plugin def overrides an ENABLED builtin of the same name", async () => {
    tmp = await mkdtemp(join(tmpdir(), "anatomia-onto-"));
    const def = {
      name: "transition-guard-example",
      description: "OVERRIDDEN",
      presetRules: [],
      templateRules: [],
    };
    await writeFile(join(tmp, "override.json"), JSON.stringify(def), "utf8");
    const onto = await loadOntology(tmp, { builtins: "all" });
    expect(onto.domains.get("transition-guard-example")!.description).toBe("OVERRIDDEN");
    expect(onto.domains.get("transition-guard-example")!.role).toBeUndefined();
  });

  it("loads state-machine only when the project supplies that domain", async () => {
    tmp = await mkdtemp(join(tmpdir(), "anatomia-onto-"));
    const def = {
      name: "state-machine",
      description: "A real project state-machine domain.",
      presetRules: [],
      templateRules: [],
    };
    await writeFile(join(tmp, "project-domain.json"), JSON.stringify(def), "utf8");
    const onto = await loadOntology(tmp);
    expect(onto.domains.get("state-machine")?.description)
      .toBe("A real project state-machine domain.");
    expect(onto.domains.has("transition-guard-example")).toBe(false);
  });

  it("reads ANATOMIA_PLUGIN_DIR when no explicit dir is passed", async () => {
    tmp = await mkdtemp(join(tmpdir(), "anatomia-onto-"));
    const def = {
      name: "env-mech",
      description: "from env.",
      presetRules: [],
      templateRules: [],
    };
    await writeFile(join(tmp, "env.json"), JSON.stringify(def), "utf8");
    process.env["ANATOMIA_PLUGIN_DIR"] = tmp;
    const onto = await loadOntology();
    expect(onto.domains.has("env-mech")).toBe(true);
  });

  it("dataOnly ignores executable defs so repo-supplied dirs cannot run code", async () => {
    tmp = await mkdtemp(join(tmpdir(), "anatomia-onto-"));
    const jsonDef = {
      name: "committed-mech",
      description: "declarative def from the repo.",
      presetRules: [],
      templateRules: [],
    };
    await writeFile(join(tmp, "committed.json"), JSON.stringify(jsonDef), "utf8");
    // An .mjs def executes at import time; under dataOnly it must not be read.
    await writeFile(
      join(tmp, "evil.mjs"),
      "globalThis.__anatomiaOntologyPluginRan = true;\n" +
        "export default { name: 'evil', description: 'x', presetRules: [], templateRules: [] };\n",
      "utf8",
    );

    const safe = await loadOntology(tmp, { dataOnly: true });
    expect(safe.domains.has("committed-mech")).toBe(true);
    expect(safe.domains.has("evil")).toBe(false);
    expect((globalThis as unknown as Record<string, unknown>)["__anatomiaOntologyPluginRan"])
      .toBeUndefined();

    // Default (operator-chosen dir) still loads executable defs.
    const full = await loadOntology(tmp);
    expect(full.domains.has("evil")).toBe(true);
    delete (globalThis as unknown as Record<string, unknown>)["__anatomiaOntologyPluginRan"];
  });

  it("rejects an invalid def", async () => {
    tmp = await mkdtemp(join(tmpdir(), "anatomia-onto-"));
    await writeFile(join(tmp, "bad.json"), JSON.stringify({ name: "x" }), "utf8");
    await expect(loadOntology(tmp)).rejects.toThrow();
  });

  it("skipInvalid drops only the bad file, so one stray .json costs no domains", async () => {
    tmp = await mkdtemp(join(tmpdir(), "anatomia-onto-"));
    const good = {
      name: "surviving-mech",
      description: "a valid def beside the junk.",
      presetRules: [],
      templateRules: [],
    };
    await writeFile(join(tmp, "good.json"), JSON.stringify(good), "utf8");
    await writeFile(join(tmp, "notes.json"), JSON.stringify({ note: "not a def" }), "utf8");
    await writeFile(join(tmp, "broken.json"), "{ this is not json", "utf8");

    const onto = await loadOntology(tmp, { dataOnly: true, skipInvalid: true });
    // A stray file costs only itself — the valid def beside it still loads.
    expect(onto.domains.has("surviving-mech")).toBe(true);
    expect(onto.domains.size).toBe(1);

    // Without skipInvalid an operator-chosen dir still fails loudly.
    await expect(loadOntology(tmp, { dataOnly: true })).rejects.toThrow();
  });

  it("rejects unassigned because it is a relation state, not a domain", async () => {
    tmp = await mkdtemp(join(tmpdir(), "anatomia-onto-"));
    const def = {
      name: "unassigned",
      description: "must not become a node",
      presetRules: [],
      templateRules: [],
    };
    await writeFile(join(tmp, "reserved.json"), JSON.stringify(def), "utf8");
    await expect(loadOntology(tmp)).rejects.toThrow(/reserved for the unassigned relation state/);
  });
});

describe("T18 builtin selection (opt-in)", () => {
  let tmp: string | null = null;
  afterEach(async () => {
    if (tmp) {
      await rm(tmp, { recursive: true, force: true });
      tmp = null;
    }
    delete process.env["ANATOMIA_PLUGIN_DIR"];
    delete process.env["ANATOMIA_BUILTIN_DOMAINS"];
  });

  async function ontologyDir(selection?: unknown): Promise<string> {
    tmp = await mkdtemp(join(tmpdir(), "anatomia-builtins-"));
    const def = {
      name: "project-mech",
      description: "the repo's own domain.",
      presetRules: [],
      templateRules: [],
    };
    await writeFile(join(tmp, "project.json"), JSON.stringify(def), "utf8");
    if (selection !== undefined) {
      await writeFile(
        join(tmp, BUILTIN_SELECTION_FILE),
        JSON.stringify({ enabled: selection }),
        "utf8",
      );
    }
    return tmp;
  }

  it("enables the builtins a committed builtins.json names", async () => {
    const dir = await ontologyDir(["transition-guard-example"]);
    const onto = await loadOntology(dir, { dataOnly: true, skipInvalid: true });
    expect(onto.domains.has("transition-guard-example")).toBe(true);
    expect(onto.domains.has("hot-path-processor")).toBe(false);
    // The selection file itself is never mistaken for a DomainDef.
    expect(onto.domains.has("builtins")).toBe(false);
    expect(onto.domains.has("project-mech")).toBe(true);
  });

  it('supports "all" and "none"', async () => {
    const all = await loadOntology(await ontologyDir("all"), { dataOnly: true });
    expect(all.domains.has("transition-guard-example")).toBe(true);
    expect(all.domains.has("hot-path-processor")).toBe(true);

    await rm(tmp!, { recursive: true, force: true });
    tmp = null;

    const none = await loadOntology(await ontologyDir("none"), { dataOnly: true });
    expect(none.domains.has("transition-guard-example")).toBe(false);
  });

  it("ignores a name this build no longer ships instead of failing the load", async () => {
    const dir = await ontologyDir(["retired-builtin", "hot-path-processor"]);
    const onto = await loadOntology(dir, { dataOnly: true });
    expect(onto.domains.has("hot-path-processor")).toBe(true);
    expect(onto.domains.has("retired-builtin")).toBe(false);
    // The repo's own domains are unaffected — this must never empty the ontology.
    expect(onto.domains.has("project-mech")).toBe(true);
  });

  it("rejects a malformed builtins.json rather than guessing", async () => {
    const dir = await ontologyDir(42);
    await expect(loadOntology(dir, { dataOnly: true })).rejects.toThrow(/builtins\.json/);
  });

  it("surfaces an unreadable selection path instead of silently disabling builtins", async () => {
    const dir = await ontologyDir();
    await mkdir(join(dir, BUILTIN_SELECTION_FILE));
    await expect(loadOntology(dir, { dataOnly: true })).rejects.toThrow();
  });

  it("lets the env var override the committed selection", async () => {
    const dir = await ontologyDir(["transition-guard-example"]);
    process.env["ANATOMIA_BUILTIN_DOMAINS"] = "none";
    const onto = await loadOntology(dir, { dataOnly: true });
    expect(onto.domains.has("transition-guard-example")).toBe(false);
    expect(onto.domains.has("project-mech")).toBe(true);
  });

  it("lets an explicit option override the env var", async () => {
    const dir = await ontologyDir("none");
    process.env["ANATOMIA_BUILTIN_DOMAINS"] = "none";
    const onto = await loadOntology(dir, { dataOnly: true, builtins: ["hot-path-processor"] });
    expect(onto.domains.has("hot-path-processor")).toBe(true);
  });

  it("resolveBuiltinSelection maps a selection to defs", () => {
    expect(resolveBuiltinSelection("none")).toEqual([]);
    expect(resolveBuiltinSelection("all").length).toBe(BUILTIN_DOMAINS.length);
    expect(resolveBuiltinSelection(["hot-path-processor"]).map((d) => d.name))
      .toEqual(["hot-path-processor"]);
    expect(DEFAULT_BUILTIN_SELECTION).toBe("none");
  });
});
