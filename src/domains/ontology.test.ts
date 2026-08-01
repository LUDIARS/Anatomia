/**
 * T18 — Tests for the domain-ontology plugin loader (ontology.ts).
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOntology, BUILTIN_DOMAINS } from "./ontology.js";

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
  });
});

describe("T18 loadOntology", () => {
  it("loads builtins when no plugin dir is given", async () => {
    delete process.env["ANATOMIA_PLUGIN_DIR"];
    const onto = await loadOntology();
    expect(onto.domains.has("transition-guard-example")).toBe(true);
    expect(onto.domains.has("state-machine")).toBe(false);
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
    expect(onto.domains.has("transition-guard-example")).toBe(true);
  });

  it("plugin def overrides a builtin of the same name", async () => {
    tmp = await mkdtemp(join(tmpdir(), "anatomia-onto-"));
    const def = {
      name: "transition-guard-example",
      description: "OVERRIDDEN",
      presetRules: [],
      templateRules: [],
    };
    await writeFile(join(tmp, "override.json"), JSON.stringify(def), "utf8");
    const onto = await loadOntology(tmp);
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
    expect(onto.domains.has("transition-guard-example")).toBe(true);
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
