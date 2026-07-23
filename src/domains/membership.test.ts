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

  it("keeps membership after a body change without absorbing overloads, peer types, or files", async () => {
    const primaryPath = "E:/repo/src/calc/primary.cpp";
    const secondaryPath = "E:/repo/src/calc/other.cpp";
    const before = await analyzeSources([
      { path: primaryPath, source: calculationSource("return value + 1;") },
      { path: secondaryPath, source: otherFileSource() },
    ]);
    const selectedBefore = before.functions.find(
      (fn) =>
        fn.sourceRange.filePath === primaryPath &&
        fn.enclosingType === "Primary" &&
        fn.signature.includes("int value"),
    );
    if (!selectedBefore?.id || !selectedBefore.signatureShape) {
      throw new Error("Primary::calculate(int) was not extracted");
    }

    const membership = {
      pathPattern: `(^|/)${escapeRegex(primaryPath)}$`,
      namePattern: "^calculate$",
      signatureShapePattern: `^${escapeRegex(selectedBefore.signatureShape)}$`,
    };
    const def: DomainDef = {
      name: "primary-calculation",
      description: "the approved Primary::calculate(int) symbol",
      presetRules: [],
      templateRules: [],
      membership: [membership],
    };
    expect((await detectDomain(def, before.graph, before.functions)).implementors).toEqual([
      selectedBefore.id,
    ]);

    const after = await analyzeSources([
      { path: primaryPath, source: calculationSource("return renamed + 99;", "renamed") },
      { path: secondaryPath, source: otherFileSource() },
    ]);
    const selectedAfter = after.functions.find(
      (fn) =>
        fn.sourceRange.filePath === primaryPath &&
        fn.enclosingType === "Primary" &&
        fn.signatureShape === selectedBefore.signatureShape,
    );
    if (!selectedAfter?.id) throw new Error("changed Primary::calculate(int) was not extracted");
    expect(selectedAfter.id).not.toBe(selectedBefore.id);

    const result = await detectDomain(def, after.graph, after.functions);
    expect(result.implementors).toEqual([selectedAfter.id]);
    const excluded = after.functions.filter((fn) => fn.id !== selectedAfter.id);
    expect(excluded).toHaveLength(4);
    for (const fn of excluded) {
      expect(result.implementors).not.toContain(fn.id);
    }

    const freeFunction = after.functions.find(
      (fn) =>
        fn.sourceRange.filePath === primaryPath &&
        fn.enclosingType === undefined &&
        fn.name === "calculate" &&
        fn.signature.includes("int value"),
    );
    if (!freeFunction?.id) throw new Error("free calculate(int) was not extracted");
    if (!freeFunction.signatureShape) throw new Error("free calculate(int) has no signature shape");
    const freeDef: DomainDef = {
      ...def,
      name: "free-calculation",
      membership: [{
        ...membership,
        signatureShapePattern: `^${escapeRegex(freeFunction.signatureShape)}$`,
      }],
    };
    expect((await detectDomain(freeDef, after.graph, after.functions)).implementors).toEqual([
      freeFunction.id,
    ]);
  });
});

async function analyzeSources(
  sources: ReadonlyArray<{ path: string; source: string }>,
): Promise<{ graph: InMemoryCodeGraph; functions: FunctionNode[] }> {
  const files: FileNode[] = [];
  for (const input of sources) {
    const tree = await parse(input.source, "cpp");
    const extracted = extractFunctions(tree, input.source, input.path);
    for (const fn of extracted) assignAnchorId(fn, normalize(fn.bodyAst));
    files.push(buildFileNode(input.path, extracted));
  }
  const edgeInfo = extractEdgeInfo(files);
  return {
    graph: new InMemoryCodeGraph(buildGraph(files, edgeInfo)),
    functions: files.flatMap((file) => file.functions),
  };
}

function calculationSource(primaryBody: string, parameterName = "value"): string {
  return `
class Primary {
public:
  int calculate(int ${parameterName}) { ${primaryBody} }
  int calculate(double value) { return static_cast<int>(value); }
};
class Secondary {
public:
  int calculate(int value) { return value + 2; }
};
int calculate(int value) { return value + 3; }
`;
}

function otherFileSource(): string {
  return `
class Primary {
public:
  int calculate(int value) { return value - 1; }
};
`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
