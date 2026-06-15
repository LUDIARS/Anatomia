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
import { detectDomain, detectDomains } from "./detect.js";
import type { DomainDef, DomainOntology } from "./ontology.js";
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
  for (const fn of functions) assignAnchorId(fn, normalize(fn.bodyAst));
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
    expect(result.conforms).toBe(false);
    const offending = result.violations.map((v) => v.anchors).flat();
    expect(offending).toContain(idOf["illegalWrite"]);
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
});
