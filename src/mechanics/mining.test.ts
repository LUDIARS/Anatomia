/**
 * T17 — Tests for rule mining (mining.ts).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { parse } from "../dag/parser.js";
import { extractFunctions } from "../dag/extract.js";
import { normalize } from "../dag/normalize.js";
import { assignAnchorId } from "../dag/hash.js";
import { buildFileNode } from "../dag/merkle.js";
import { buildGraph, extractEdgeInfo } from "../graph/build.js";
import { InMemoryCodeGraph } from "../graph/in-memory.js";
import { mineRules } from "./mining.js";
import type { FunctionNode, FileNode } from "../types.js";

// hub_fn is called by many; leaf_fn is called by none; util_fn called once.
const SRC = `
int leaf_fn() { return 0; }
int util_fn() { return 1; }
int hub_fn() { return 2; }
int x1() { return hub_fn(); }
int x2() { return hub_fn() + util_fn(); }
int x3() { return hub_fn(); }
`;

let q: InMemoryCodeGraph;
let fnByName: Record<string, FunctionNode>;

beforeAll(async () => {
  const tree = await parse(SRC, "cpp");
  const fns = extractFunctions(tree, SRC, "/m.cpp");
  for (const fn of fns) assignAnchorId(fn, normalize(fn.bodyAst));
  const file: FileNode = buildFileNode("/m.cpp", fns);
  const ei = extractEdgeInfo([file]);
  tree.delete();
  q = new InMemoryCodeGraph(buildGraph([file], ei));
  fnByName = {};
  for (const fn of file.functions) fnByName[fn.name] = fn;
});

describe("T17 mineRules — fan-in heuristic", () => {
  it("proposes a FanInCap for a low-fan-in exemplar", async () => {
    const cands = await mineRules(fnByName["leaf_fn"]!, q);
    const fanCap = cands.find((c) => c.predicate.type === "FanInCap");
    expect(fanCap).toBeDefined();
    expect(fanCap!.confidence).toBeGreaterThan(0.5);
    expect(fanCap!.rationale).toContain("fan-in");
  });

  it("does NOT propose a low FanInCap for a high-fan-in hub", async () => {
    const cands = await mineRules(fnByName["hub_fn"]!, q);
    const fanCap = cands.find((c) => c.predicate.type === "FanInCap");
    // hub_fn fan-in is above average => no fan-in-cap candidate.
    expect(fanCap).toBeUndefined();
  });
});

describe("T17 mineRules — narrow call set heuristic", () => {
  it("proposes a forbiddenCall for a narrow-out-degree exemplar", async () => {
    const cands = await mineRules(fnByName["x1"]!, q);
    const forb = cands.find((c) => c.predicate.type === "EdgeForbidden");
    expect(forb).toBeDefined();
    expect(forb!.rationale).toContain("out-degree");
  });
});

describe("T17 mineRules — hot-path heuristic", () => {
  it("proposes hotPathNoAlloc for a hot exemplar with no alloc calls", async () => {
    // Tag leaf_fn as hotPath on its CodeNode (tags are externally supplied).
    const node = await q.getNode(fnByName["leaf_fn"]!.id!);
    node!.tags = ["hotPath"];
    const cands = await mineRules(fnByName["leaf_fn"]!, q, {
      hotPathTag: "hotPath",
      allocTag: "alloc",
    });
    const hot = cands.find(
      (c) => c.predicate.type === "EdgeForbidden" && c.rationale.includes("hotPath"),
    );
    expect(hot).toBeDefined();
    expect(hot!.confidence).toBeGreaterThan(0.5);
  });
});
