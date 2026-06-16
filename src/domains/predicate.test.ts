/**
 * T14 — Tests for NodeFilter matching helpers, focusing on pathPattern.
 */

import { describe, it, expect } from "vitest";
import { matchesFilter, selectNodes } from "./predicate.js";
import type { CodeNode, NodeFilter } from "../types.js";

function makeNode(name: string, filePath: string, kind: CodeNode["kind"] = "function"): CodeNode {
  return {
    id: `anchor-${name}` as CodeNode["id"],
    name,
    kind,
    sourceRange: {
      filePath,
      start: { line: 1, column: 0 },
      end: { line: 10, column: 0 },
    },
  };
}

const nodeA = makeNode("activate", "E:/Ars/src/skill/activation/activate.ts");
const nodeB = makeNode("tick",     "E:/Ars/src/core/tick.ts");
const nodeC = makeNode("apply",    "E:/Ars/src/skill/apply.ts");

describe("NodeFilter.pathPattern", () => {
  it("matches nodes whose file path contains the pattern", () => {
    const f: NodeFilter = { pathPattern: "skill/activation" };
    expect(matchesFilter(nodeA, f)).toBe(true);
    expect(matchesFilter(nodeB, f)).toBe(false);
    expect(matchesFilter(nodeC, f)).toBe(false);
  });

  it("normalises backslashes to forward slashes before matching", () => {
    const nodeWin = makeNode("fn", "E:\\Ars\\src\\skill\\activation\\activate.ts");
    const f: NodeFilter = { pathPattern: "skill/activation" };
    expect(matchesFilter(nodeWin, f)).toBe(true);
  });

  it("composes with namePattern (AND semantics)", () => {
    const f: NodeFilter = { pathPattern: "skill", namePattern: "^apply$" };
    expect(matchesFilter(nodeA, f)).toBe(false); // name doesn't match
    expect(matchesFilter(nodeC, f)).toBe(true);  // both match
    expect(matchesFilter(nodeB, f)).toBe(false); // path doesn't match
  });

  it("empty pathPattern matches everything (consistent with other fields)", () => {
    const f: NodeFilter = { pathPattern: "" };
    expect(matchesFilter(nodeA, f)).toBe(true);
    expect(matchesFilter(nodeB, f)).toBe(true);
  });

  it("regex anchors work in pathPattern", () => {
    const f: NodeFilter = { pathPattern: "/src/skill/activation/" };
    expect(matchesFilter(nodeA, f)).toBe(true);
    expect(matchesFilter(nodeC, f)).toBe(false);
  });

  it("selectNodes filters by pathPattern", () => {
    const f: NodeFilter = { pathPattern: "skill" };
    const selected = selectNodes([nodeA, nodeB, nodeC], f);
    expect(selected).toHaveLength(2);
    expect(selected.map((n) => n.name)).toContain("activate");
    expect(selected.map((n) => n.name)).toContain("apply");
  });
});
