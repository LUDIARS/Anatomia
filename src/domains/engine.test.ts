/**
 * T14 — Tests for the predicate engine (engine.ts + predicate.ts).
 *
 * Builds a small graph from C++ source and checks each predicate kind:
 * EdgeForbidden, FanInCap, NoCycle, and the And/Or/Not combinators.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { parse } from "../dag/parser.js";
import { extractFunctions } from "../dag/extract.js";
import { normalize } from "../dag/normalize.js";
import { assignAnchorId } from "../dag/hash.js";
import { buildFileNode } from "../dag/merkle.js";
import { buildGraph, extractEdgeInfo } from "../graph/build.js";
import { InMemoryCodeGraph } from "../graph/in-memory.js";
import { evaluatePredicate } from "./engine.js";
import type { Predicate, FileNode, AnchorId } from "../types.js";
import type { FunctionEdgeInfo } from "../graph/build.js";

// a -> b -> c chain; d isolated; e <-> f cycle.
const SRC = `
int c_fn() { return 3; }
int b_fn() { return c_fn() + 2; }
int a_fn() { return b_fn() + 1; }
int d_fn() { return 99; }
void f_fn();
void e_fn() { f_fn(); }
void f_fn() { e_fn(); }
`;

let q: InMemoryCodeGraph;
let idOf: Record<string, AnchorId>;

beforeAll(async () => {
  const tree = await parse(SRC, "cpp");
  const fns = extractFunctions(tree, SRC, "/chain.cpp");
  for (const fn of fns) assignAnchorId(fn, normalize(fn.bodyAst));
  const file: FileNode = buildFileNode("/chain.cpp", fns);
  const edgeInfo: Map<AnchorId, FunctionEdgeInfo> = extractEdgeInfo([file]);
  tree.delete();
  const graph = buildGraph([file], edgeInfo);
  q = new InMemoryCodeGraph(graph);
  idOf = {};
  for (const fn of file.functions) idOf[fn.name] = fn.id!;
});

describe("T14 EdgeForbidden", () => {
  it("flags the forbidden a_fn -> b_fn call edge", async () => {
    const pred: Predicate = {
      type: "EdgeForbidden",
      from: { namePattern: "^a_fn$" },
      to: { namePattern: "^b_fn$" },
      kind: "calls",
    };
    const v = await evaluatePredicate(pred, q, { ruleId: "r1" });
    expect(v.length).toBe(1);
    expect(v[0]!.ruleId).toBe("r1");
    expect(v[0]!.anchors).toContain(idOf["a_fn"]);
    expect(v[0]!.anchors).toContain(idOf["b_fn"]);
    expect(v[0]!.severity).toBe("error");
  });

  it("no violation when the forbidden edge does not exist", async () => {
    const pred: Predicate = {
      type: "EdgeForbidden",
      from: { namePattern: "^a_fn$" },
      to: { namePattern: "^c_fn$" },
      kind: "calls",
    };
    const v = await evaluatePredicate(pred, q);
    expect(v).toHaveLength(0);
  });
});

describe("T14 FanInCap", () => {
  it("flags c_fn when fan-in exceeds cap 0", async () => {
    const pred: Predicate = {
      type: "FanInCap",
      target: { namePattern: "^c_fn$" },
      max: 0,
    };
    const v = await evaluatePredicate(pred, q);
    expect(v.length).toBe(1);
    expect(v[0]!.anchors).toEqual([idOf["c_fn"]]);
  });

  it("no violation when cap is high enough", async () => {
    const pred: Predicate = {
      type: "FanInCap",
      target: { namePattern: "^c_fn$" },
      max: 5,
    };
    const v = await evaluatePredicate(pred, q);
    expect(v).toHaveLength(0);
  });
});

describe("T14 NoCycle", () => {
  it("detects the e_fn <-> f_fn cycle", async () => {
    const pred: Predicate = { type: "NoCycle", scope: {}, kind: "calls" };
    const v = await evaluatePredicate(pred, q);
    expect(v.length).toBeGreaterThanOrEqual(1);
    const cyc = v.find((x) => x.anchors.includes(idOf["e_fn"]!));
    expect(cyc).toBeDefined();
    expect(cyc!.anchors).toContain(idOf["f_fn"]);
  });

  it("no cycle within the acyclic a/b/c scope", async () => {
    const pred: Predicate = {
      type: "NoCycle",
      scope: { namePattern: "^(a_fn|b_fn|c_fn)$" },
      kind: "calls",
    };
    const v = await evaluatePredicate(pred, q);
    expect(v).toHaveLength(0);
  });
});

describe("T14 And / Or / Not combinators", () => {
  it("And: union of child violations", async () => {
    const pred: Predicate = {
      type: "And",
      children: [
        { type: "EdgeForbidden", from: { namePattern: "^a_fn$" }, to: { namePattern: "^b_fn$" }, kind: "calls" },
        { type: "EdgeForbidden", from: { namePattern: "^b_fn$" }, to: { namePattern: "^c_fn$" }, kind: "calls" },
      ],
    };
    const v = await evaluatePredicate(pred, q);
    expect(v.length).toBe(2);
  });

  it("Or: satisfied (no violation) when one branch holds", async () => {
    const pred: Predicate = {
      type: "Or",
      children: [
        // a_fn -> c_fn does NOT exist => this branch holds (no violation)
        { type: "EdgeForbidden", from: { namePattern: "^a_fn$" }, to: { namePattern: "^c_fn$" }, kind: "calls" },
        // a_fn -> b_fn exists => this branch is violated
        { type: "EdgeForbidden", from: { namePattern: "^a_fn$" }, to: { namePattern: "^b_fn$" }, kind: "calls" },
      ],
    };
    const v = await evaluatePredicate(pred, q);
    expect(v).toHaveLength(0);
  });

  it("Or: violated only when every branch is violated", async () => {
    const pred: Predicate = {
      type: "Or",
      children: [
        { type: "EdgeForbidden", from: { namePattern: "^a_fn$" }, to: { namePattern: "^b_fn$" }, kind: "calls" },
        { type: "EdgeForbidden", from: { namePattern: "^b_fn$" }, to: { namePattern: "^c_fn$" }, kind: "calls" },
      ],
    };
    const v = await evaluatePredicate(pred, q);
    expect(v.length).toBe(1);
    expect(v[0]!.evidence).toContain("all Or-branches violated");
  });

  it("Not: violation when the inner constraint holds", async () => {
    // Inner: forbid a_fn -> c_fn (which does not exist) => inner holds =>
    // Not(inner) => violation.
    const pred: Predicate = {
      type: "Not",
      child: { type: "EdgeForbidden", from: { namePattern: "^a_fn$" }, to: { namePattern: "^c_fn$" }, kind: "calls" },
    };
    const v = await evaluatePredicate(pred, q);
    expect(v.length).toBe(1);
  });

  it("Not: no violation when the inner constraint is broken", async () => {
    // Inner: forbid a_fn -> b_fn (which DOES exist) => inner violated =>
    // Not(inner) => no violation.
    const pred: Predicate = {
      type: "Not",
      child: { type: "EdgeForbidden", from: { namePattern: "^a_fn$" }, to: { namePattern: "^b_fn$" }, kind: "calls" },
    };
    const v = await evaluatePredicate(pred, q);
    expect(v).toHaveLength(0);
  });
});
