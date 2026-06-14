/**
 * T11 — Tests for in-memory code graph builder (build.ts).
 *
 * The full G1 pipeline (parse → extract → normalize → assignAnchorId) is run
 * to get properly-hashed FileNodes.  Crucially, extractEdgeInfo() is called
 * BEFORE tree.delete() so that AST walking completes while WASM memory is live.
 * buildGraph() is then called with the resulting edgeInfoMap (safe to call after
 * the tree is gone).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { parse } from "../../dag/parser.js";
import { extractFunctions } from "../../dag/extract.js";
import { normalize } from "../../dag/normalize.js";
import { assignAnchorId } from "../../dag/hash.js";
import { buildFileNode } from "../../dag/merkle.js";
import { buildGraph, extractEdgeInfo } from "../build.js";
import type { FileNode, AnchorId } from "../../types.js";
import type { FunctionEdgeInfo } from "../build.js";

// ---------------------------------------------------------------------------
// Helper: parse → extract → hash → extractEdgeInfo → tree.delete() → FileNode
// ---------------------------------------------------------------------------

async function makeFileWithEdgeInfo(
  src: string,
  path: string,
): Promise<{ file: FileNode; edgeInfo: Map<AnchorId, FunctionEdgeInfo> }> {
  const tree = await parse(src, "cpp");
  const fns = extractFunctions(tree, src, path);
  for (const fn of fns) {
    assignAnchorId(fn, normalize(fn.bodyAst));
  }
  // *** extractEdgeInfo BEFORE tree.delete() ***
  const file = buildFileNode(path, fns);
  const edgeInfo = extractEdgeInfo([file]);
  tree.delete();
  return { file, edgeInfo };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

// caller() calls callee() — simple direct call edge.
const CALLER_SRC = `
void callee() { return; }
void caller() { callee(); }
`;

// Mutual recursion: ping() calls pong(), pong() calls ping().
const MUTUAL_SRC = `
void pong();
void ping() { pong(); }
void pong() { ping(); }
`;

// Self-recursion.
const SELF_RECURSE_SRC = `
int fact(int n) { if(n <= 1) return 1; return n * fact(n - 1); }
`;

// Two files: fileA has foo(), fileB has bar() calling foo() cross-file.
const FILE_A_SRC = `int foo(int x) { return x + 1; }`;
const FILE_B_SRC = `
int bar(int x) { return foo(x) * 2; }
`;

// callee called multiple times — should produce only 1 calls edge.
const DUP_CALL_SRC = `
void target() {}
void caller() { target(); target(); target(); }
`;

let simpleFile: FileNode;
let simpleEdgeInfo: Map<AnchorId, FunctionEdgeInfo>;
let mutualFile: FileNode;
let mutualEdgeInfo: Map<AnchorId, FunctionEdgeInfo>;
let selfFile: FileNode;
let selfEdgeInfo: Map<AnchorId, FunctionEdgeInfo>;
let crossFileA: FileNode;
let crossFileB: FileNode;
let crossEdgeInfoA: Map<AnchorId, FunctionEdgeInfo>;
let crossEdgeInfoB: Map<AnchorId, FunctionEdgeInfo>;
let dupFile: FileNode;
let dupEdgeInfo: Map<AnchorId, FunctionEdgeInfo>;

beforeAll(async () => {
  ({ file: simpleFile, edgeInfo: simpleEdgeInfo } = await makeFileWithEdgeInfo(CALLER_SRC, "/simple.cpp"));
  ({ file: mutualFile, edgeInfo: mutualEdgeInfo } = await makeFileWithEdgeInfo(MUTUAL_SRC, "/mutual.cpp"));
  ({ file: selfFile, edgeInfo: selfEdgeInfo } = await makeFileWithEdgeInfo(SELF_RECURSE_SRC, "/self.cpp"));
  ({ file: crossFileA, edgeInfo: crossEdgeInfoA } = await makeFileWithEdgeInfo(FILE_A_SRC, "/fileA.cpp"));
  ({ file: crossFileB, edgeInfo: crossEdgeInfoB } = await makeFileWithEdgeInfo(FILE_B_SRC, "/fileB.cpp"));
  ({ file: dupFile, edgeInfo: dupEdgeInfo } = await makeFileWithEdgeInfo(DUP_CALL_SRC, "/dup.cpp"));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T11 buildGraph — nodes", () => {
  it("creates a CodeNode for each function with the correct AnchorId", () => {
    const graph = buildGraph([simpleFile], simpleEdgeInfo);
    expect(graph.nodes.size).toBe(2);
    for (const fn of simpleFile.functions) {
      expect(fn.id).not.toBeNull();
      expect(graph.nodes.has(fn.id!)).toBe(true);
      const node = graph.nodes.get(fn.id!)!;
      expect(node.name).toBe(fn.name);
      expect(node.kind).toBe("function");
    }
  });

  it("nodes across two files are all present", () => {
    const combined = new Map([...crossEdgeInfoA, ...crossEdgeInfoB]);
    const graph = buildGraph([crossFileA, crossFileB], combined);
    expect(graph.nodes.size).toBe(2);
  });
});

describe("T11 buildGraph — calls edges", () => {
  it("emits a calls edge from caller to callee", () => {
    const graph = buildGraph([simpleFile], simpleEdgeInfo);
    const callerId = simpleFile.functions.find((f) => f.name === "caller")?.id;
    const calleeId = simpleFile.functions.find((f) => f.name === "callee")?.id;
    expect(callerId).toBeDefined();
    expect(calleeId).toBeDefined();

    const edges = graph.adjacency.get(callerId!)!;
    expect(edges.some((e) => e.to === calleeId && e.kind === "calls")).toBe(true);
  });

  it("preserves mutual recursion as a cycle (ping → pong, pong → ping)", () => {
    const graph = buildGraph([mutualFile], mutualEdgeInfo);
    const pingId = mutualFile.functions.find((f) => f.name === "ping")?.id;
    const pongId = mutualFile.functions.find((f) => f.name === "pong")?.id;
    expect(pingId).toBeDefined();
    expect(pongId).toBeDefined();

    const pingOut = graph.adjacency.get(pingId!)!;
    const pongOut = graph.adjacency.get(pongId!)!;
    expect(pingOut.some((e) => e.to === pongId && e.kind === "calls")).toBe(true);
    expect(pongOut.some((e) => e.to === pingId && e.kind === "calls")).toBe(true);
  });

  it("preserves self-recursion (fact → fact)", () => {
    const graph = buildGraph([selfFile], selfEdgeInfo);
    const factId = selfFile.functions.find((f) => f.name === "fact")?.id;
    expect(factId).toBeDefined();

    const out = graph.adjacency.get(factId!)!;
    expect(out.some((e) => e.to === factId && e.kind === "calls")).toBe(true);
  });

  it("resolves cross-file calls by name (bar calls foo)", () => {
    const combined = new Map([...crossEdgeInfoA, ...crossEdgeInfoB]);
    const graph = buildGraph([crossFileA, crossFileB], combined);
    const fooId = crossFileA.functions.find((f) => f.name === "foo")?.id;
    const barId = crossFileB.functions.find((f) => f.name === "bar")?.id;
    expect(fooId).toBeDefined();
    expect(barId).toBeDefined();

    const out = graph.adjacency.get(barId!)!;
    expect(out.some((e) => e.to === fooId && e.kind === "calls")).toBe(true);
  });
});

describe("T11 buildGraph — reverse adjacency", () => {
  it("callee has caller in its reverse adjacency (fan-in)", () => {
    const graph = buildGraph([simpleFile], simpleEdgeInfo);
    const calleeId = simpleFile.functions.find((f) => f.name === "callee")?.id;
    const callerId = simpleFile.functions.find((f) => f.name === "caller")?.id;
    const inEdges = graph.reverseAdjacency.get(calleeId!)!;
    expect(inEdges.some((e) => e.from === callerId)).toBe(true);
  });
});

describe("T11 buildGraph — edge deduplication", () => {
  it("does not create duplicate edges even when callee is called multiple times", () => {
    const graph = buildGraph([dupFile], dupEdgeInfo);
    const callerId = dupFile.functions.find((f) => f.name === "caller")?.id;
    const out = graph.adjacency.get(callerId!)!;
    const callsEdges = out.filter((e) => e.kind === "calls");
    // extractEdgeInfo deduplicates callee names; should be exactly 1 edge.
    expect(callsEdges.length).toBe(1);
  });
});
