/**
 * T18 — Tests for the domain-ontology plugin loader (ontology.ts).
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOntology, BUILTIN_DOMAINS } from "./ontology.js";

describe("T18 BUILTIN_DOMAINS", () => {
  it("ships at least two builtin domains", () => {
    expect(BUILTIN_DOMAINS.length).toBeGreaterThanOrEqual(2);
    const names = BUILTIN_DOMAINS.map((m) => m.name);
    expect(names).toContain("state-machine");
    expect(names).toContain("hot-path-processor");
  });
});

describe("T18 loadOntology", () => {
  it("loads builtins when no plugin dir is given", async () => {
    delete process.env["ANATOMIA_PLUGIN_DIR"];
    const onto = await loadOntology();
    expect(onto.domains.has("state-machine")).toBe(true);
    expect(onto.domains.has("hot-path-processor")).toBe(true);
  });

  let tmp: string | null = null;
  afterEach(async () => {
    if (tmp) {
      await rm(tmp, { recursive: true, force: true });
      tmp = null;
    }
    delete process.env["ANATOMIA_PLUGIN_DIR"];
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
    // builtins still present
    expect(onto.domains.has("state-machine")).toBe(true);
  });

  it("plugin def overrides a builtin of the same name", async () => {
    tmp = await mkdtemp(join(tmpdir(), "anatomia-onto-"));
    const def = {
      name: "state-machine",
      description: "OVERRIDDEN",
      presetRules: [],
      templateRules: [],
    };
    await writeFile(join(tmp, "override.json"), JSON.stringify(def), "utf8");
    const onto = await loadOntology(tmp);
    expect(onto.domains.get("state-machine")!.description).toBe("OVERRIDDEN");
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

  it("rejects an invalid def", async () => {
    tmp = await mkdtemp(join(tmpdir(), "anatomia-onto-"));
    await writeFile(join(tmp, "bad.json"), JSON.stringify({ name: "x" }), "utf8");
    await expect(loadOntology(tmp)).rejects.toThrow();
  });
});
