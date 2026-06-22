/**
 * Tests for DomainDef.membership — declarative node ownership (domain-retune).
 * A membership-only domain (zero rules) must surface its nodes as implementors
 * and never report a violation.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { parse } from "../dag/parser.js";
import { extractFunctions } from "../dag/extract.js";
import { normalize } from "../dag/normalize.js";
import { assignAnchorId } from "../dag/hash.js";
import { buildFileNode } from "../dag/merkle.js";
import { buildGraph, extractEdgeInfo } from "../graph/build.js";
import { InMemoryCodeGraph } from "../graph/in-memory.js";
import { detectDomain } from "./detect.js";
import type { DomainDef } from "./ontology.js";
import type { FunctionNode, FileNode } from "../types.js";

const GRAPH_SRC = `int loadGraph() { return 1; }`;
const WEB_SRC = `int handleRequest() { return 2; }`;

let q: InMemoryCodeGraph;
let functions: FunctionNode[];
let idOf: Record<string, string>;

beforeAll(async () => {
  const gTree = await parse(GRAPH_SRC, "cpp");
  const wTree = await parse(WEB_SRC, "cpp");
  // Use ABSOLUTE paths (as analyze() does): membership patterns must match the
  // node's full path, not a repo-relative one — a `^src/` anchor would silently
  // match nothing here (this is exactly the bug that shipped 0 implementors).
  const gPath = "E:/Document/Ars/Anatomia/src/graph/build.cpp";
  const wPath = "E:/Document/Ars/Anatomia/src/adapters/web/server.cpp";
  const gFns = extractFunctions(gTree, GRAPH_SRC, gPath);
  const wFns = extractFunctions(wTree, WEB_SRC, wPath);
  functions = [...gFns, ...wFns];
  for (const fn of functions) assignAnchorId(fn, normalize(fn.bodyAst));
  const gFile: FileNode = buildFileNode(gPath, gFns);
  const wFile: FileNode = buildFileNode(wPath, wFns);
  const ei = extractEdgeInfo([gFile, wFile]);
  q = new InMemoryCodeGraph(buildGraph([gFile, wFile], ei));
  idOf = {};
  for (const fn of [...gFile.functions, ...wFile.functions]) idOf[fn.name] = fn.id!;
});

describe("DomainDef.membership", () => {
  it("owns nodes by path pattern as implementors, with no violation", async () => {
    const def: DomainDef = {
      name: "structural-graph",
      description: "the code graph layer",
      presetRules: [],
      templateRules: [],
      membership: [{ pathPattern: "(^|/)src/graph/[^/]+$" }],
    };
    const r = await detectDomain(def, q, functions);
    expect(r.implementors).toContain(idOf["loadGraph"]);
    expect(r.implementors).not.toContain(idOf["handleRequest"]);
    expect(r.violations).toHaveLength(0);
    expect(r.conforms).toBe(true);
  });

  it("owns nodes by name pattern too", async () => {
    const def: DomainDef = {
      name: "web",
      description: "panel handlers",
      presetRules: [],
      templateRules: [],
      membership: [{ namePattern: "^handle" }],
    };
    const r = await detectDomain(def, q, functions);
    expect(r.implementors).toEqual([idOf["handleRequest"]]);
  });
});
