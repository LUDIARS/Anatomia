/**
 * T19 — Tests for domain detection (detect.ts).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { parse } from "../dag/parser.js";
import { extractFunctions } from "../dag/extract.js";
import { normalize } from "../dag/normalize.js";
import { assignAnchorId } from "../dag/hash.js";
import { buildFileNode } from "../dag/merkle.js";
import { buildGraph, extractEdgeInfo } from "../graph/build.js";
import { InMemoryCodeGraph } from "../graph/in-memory.js";
import { detectDomain, detectDomains, partitionDetectionResults } from "./detect.js";
import { BUILTIN_DOMAINS, type DomainDef, type DomainOntology } from "./ontology.js";
import type { FunctionNode, FileNode } from "../types.js";

// A function that does a forbidden direct mutate, and one that is clean.
const SRC = `
void applyTransition() { obj.set(value); }
void illegalWrite() { obj.mutate(value); }
`;

let q: InMemoryCodeGraph;
let functions: FunctionNode[];
let idOf: Record<string, string>;

beforeAll(async () => {
  const tree = await parse(SRC, "cpp");
  functions = extractFunctions(tree, SRC, "/d.cpp");
  for (const fn of functions) assignAnchorId(fn, normalize(fn.bodyAst!));
  const file: FileNode = buildFileNode("/d.cpp", functions);
  const ei = extractEdgeInfo([file]);
  // NOTE: keep tree alive — detection re-reads bodyAst for templates.
  q = new InMemoryCodeGraph(buildGraph([file], ei));
  idOf = {};
  for (const fn of file.functions) idOf[fn.name] = fn.id!;
});

const MECH: DomainDef = {
  name: "no-direct-mutate",
  description: "State must not be mutated directly.",
  presetRules: [],
  templateRules: [
    {
      id: "no-direct-mutate/tpl",
      pattern: "$O.mutate($A)",
      metavars: ["O", "A"],
      language: "cpp",
      positive: false,
    },
  ],
};

describe("T19 detectDomain", () => {
  it("flags the illegalWrite function as a violation", async () => {
    const result = await detectDomain(MECH, q, functions);
    expect(result.domain).toBe("no-direct-mutate");
    expect(result.role).toBe("semantic");
    expect(result.conforms).toBe(false);
    const offending = result.violations.map((v) => v.anchors).flat();
    expect(offending).toContain(idOf["illegalWrite"]);
  });

  it("preserves a legacy already-qualified template rule id", async () => {
    const result = await detectDomain(MECH, q, functions);
    const ids = result.violations.map((violation) => violation.ruleId);
    expect(ids).toContain("no-direct-mutate/tpl");
    expect(ids).not.toContain("no-direct-mutate/no-direct-mutate/tpl");
  });

  it("a clean ontology conforms (no violations)", async () => {
    const clean: DomainDef = {
      name: "clean",
      description: "no rules that fail here",
      presetRules: [{ preset: "couplingCap", params: { targetPattern: ".*", maxFanOut: 100 } }],
      templateRules: [],
    };
    const result = await detectDomain(clean, q, functions);
    expect(result.conforms).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("qualifies the builtin template rule exactly once", async () => {
    const example = BUILTIN_DOMAINS.find(
      (domain) => domain.name === "transition-guard-example",
    );
    if (!example) throw new Error("missing transition-guard-example builtin");
    const result = await detectDomain(example, q, functions);
    expect(result.role).toBe("policy");
    const ids = result.violations.map((violation) => violation.ruleId);
    expect(ids).toContain("transition-guard-example/no-direct-mutate");
    expect(ids).not.toContain(
      "transition-guard-example/transition-guard-example/no-direct-mutate",
    );
  });

  it("rejects unassigned as a DomainDef name", async () => {
    const invalid: DomainDef = {
      name: "unassigned",
      description: "relation state",
      presetRules: [],
      templateRules: [],
    };
    await expect(detectDomain(invalid, q, functions))
      .rejects.toThrow(/reserved for the unassigned relation state/);
  });
});

describe("T19 detectDomains (ontology-wide)", () => {
  it("runs every domain in the ontology", async () => {
    const onto: DomainOntology = {
      domains: new Map([["no-direct-mutate", MECH]]),
    };
    const results = await detectDomains(onto, q, functions);
    expect(results.length).toBe(1);
    expect(results[0]!.domain).toBe("no-direct-mutate");
  });

  it("separates policy evaluation from semantic domain ownership", async () => {
    const policy: DomainDef = {
      ...MECH,
      name: "mutation-policy",
      role: "policy",
    };
    const onto: DomainOntology = {
      domains: new Map([
        [MECH.name, MECH],
        [policy.name, policy],
      ]),
    };
    const partition = partitionDetectionResults(await detectDomains(onto, q, functions));
    expect(partition.domains.map((result) => result.domain)).toEqual([MECH.name]);
    expect(partition.policyResults.map((result) => result.domain)).toEqual([policy.name]);
  });
});
