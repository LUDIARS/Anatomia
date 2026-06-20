/**
 * T15 — Tests for the preset rule catalog (presets.ts).
 *
 * Each preset is a pure factory returning a Predicate; tests assert the shape
 * of the produced predicate and that a couple of them evaluate correctly via
 * the engine on a tiny graph.
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
import {
  layerDependencyDirection,
  stateAccessPath,
  forbiddenCall,
  couplingCap,
  noCycle,
  hotPathNoAlloc,
  buildPresetPredicate,
} from "./presets.js";
import type { AnchorId, FileNode } from "../types.js";

describe("T15 preset shapes", () => {
  it("forbiddenCall builds an EdgeForbidden predicate", () => {
    const p = forbiddenCall({ callerPattern: "Effect", calleePattern: "Control" });
    expect(p.type).toBe("EdgeForbidden");
  });

  it("couplingCap with both caps builds an And of FanIn/FanOut", () => {
    const p = couplingCap({ targetPattern: ".*", maxFanIn: 3, maxFanOut: 5 });
    expect(p.type).toBe("And");
  });

  it("couplingCap with one cap builds a single FanCap", () => {
    const p = couplingCap({ targetPattern: ".*", maxFanIn: 3 });
    expect(p.type).toBe("FanInCap");
  });

  it("couplingCap with no cap throws", () => {
    expect(() => couplingCap({ targetPattern: ".*" })).toThrow();
  });

  it("noCycle builds a NoCycle predicate (empty scope when no pattern)", () => {
    const p = noCycle();
    expect(p.type).toBe("NoCycle");
  });

  it("hotPathNoAlloc forbids calls between tag filters", () => {
    const p = hotPathNoAlloc({ hotPathTag: "hotPath", allocTag: "alloc" });
    expect(p.type).toBe("EdgeForbidden");
    if (p.type === "EdgeForbidden") {
      expect(p.from.tags).toEqual(["hotPath"]);
      expect(p.to.tags).toEqual(["alloc"]);
    }
  });

  it("layerDependencyDirection builds forbidden edges for each lower->higher pair", () => {
    const p = layerDependencyDirection({ layers: ["core", "mid", "ui"] });
    // 3 layers => 3 forbidden pairs => And of 3.
    expect(p.type).toBe("And");
    if (p.type === "And") expect(p.children.length).toBe(3);
  });

  it("buildPresetPredicate dispatches by id", () => {
    const p = buildPresetPredicate("noCycle", {});
    expect(p.type).toBe("NoCycle");
  });

  it("layerDependencyDirection by:path emits pathPattern filters (not namePattern)", () => {
    const p = layerDependencyDirection({ layers: ["/util/", "/render/", "/enemy/"], by: "path" });
    expect(p.type).toBe("And");
    if (p.type === "And") {
      const first = p.children[0]!;
      expect(first.type).toBe("EdgeForbidden");
      if (first.type === "EdgeForbidden") {
        expect(first.from.pathPattern).toBe("/util/");
        expect(first.from.namePattern).toBeUndefined();
        expect(first.to.pathPattern).toBe("/render/");
      }
    }
  });

  it("forbiddenCall/couplingCap honour by:path", () => {
    const f = forbiddenCall({ callerPattern: "/render/", calleePattern: "/enemy/", by: "path" });
    if (f.type === "EdgeForbidden") {
      expect(f.from.pathPattern).toBe("/render/");
      expect(f.to.pathPattern).toBe("/enemy/");
    }
    const c = couplingCap({ targetPattern: "/render/", maxFanOut: 8, by: "path" });
    if (c.type === "FanOutCap") expect(c.target.pathPattern).toBe("/render/");
  });

  it("stateAccessPath builds an EdgeForbidden with a negative-lookahead caller", () => {
    const p = stateAccessPath({ statePattern: "State$", allowedCallerPattern: "Transition" });
    expect(p.type).toBe("EdgeForbidden");
    if (p.type === "EdgeForbidden") {
      expect(p.from.namePattern).toContain("?!");
    }
  });
});

// ── Evaluation sanity: forbiddenCall on a real graph. ───────────────────────

const SRC = `
int Control() { return 1; }
int Effect() { return Control(); }
int Brain() { return 2; }
`;

describe("T15 preset evaluation", () => {
  let q: InMemoryCodeGraph;
  let idOf: Record<string, AnchorId>;
  beforeAll(async () => {
    const tree = await parse(SRC, "cpp");
    const fns = extractFunctions(tree, SRC, "/r.cpp");
    for (const fn of fns) assignAnchorId(fn, normalize(fn.bodyAst));
    const file: FileNode = buildFileNode("/r.cpp", fns);
    const ei = extractEdgeInfo([file]);
    tree.delete();
    q = new InMemoryCodeGraph(buildGraph([file], ei));
    idOf = {};
    for (const fn of file.functions) idOf[fn.name] = fn.id!;
  });

  it("forbiddenCall Effect->Control flags the violation", async () => {
    const p = forbiddenCall({ callerPattern: "^Effect$", calleePattern: "^Control$" });
    const v = await evaluatePredicate(p, q);
    expect(v.length).toBe(1);
    expect(v[0]!.anchors).toContain(idOf["Effect"]);
  });

  it("forbiddenCall Brain->Control finds nothing (no such edge)", async () => {
    const p = forbiddenCall({ callerPattern: "^Brain$", calleePattern: "^Control$" });
    const v = await evaluatePredicate(p, q);
    expect(v).toHaveLength(0);
  });
});
