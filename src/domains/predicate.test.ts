/**
 * Tests for NodeFilter matching (predicate.ts), focused on `pathPattern` — the
 * source-path matcher that lets directory-structured codebases express layer
 * rules by location instead of by name.
 */

import { describe, it, expect } from "vitest";
import { matchesFilter, selectNodes } from "./predicate.js";
import type { AnchorId, CodeNode } from "../types.js";

/** Build a minimal function CodeNode rooted at a given file path. */
function node(name: string, filePath: string): CodeNode {
  return {
    id: `${filePath}#${name}` as unknown as AnchorId,
    name,
    kind: "function",
    sourceRange: {
      start: { line: 1, column: 0 },
      end: { line: 2, column: 0 },
      filePath,
    },
  };
}

describe("matchesFilter pathPattern", () => {
  const enemy = node("update", "E:/repo/src/enemy/slime.cpp");
  const render = node("update", "E:/repo/src/render/pass.cpp");

  it("matches when the source path matches the regex", () => {
    expect(matchesFilter(enemy, { pathPattern: "/enemy/" })).toBe(true);
    expect(matchesFilter(render, { pathPattern: "/enemy/" })).toBe(false);
  });

  it("normalises backslashes so a forward-slash pattern is OS-independent", () => {
    const win = node("draw", "E:\\repo\\src\\render\\pass.cpp");
    expect(matchesFilter(win, { pathPattern: "/render/" })).toBe(true);
  });

  it("ANDs pathPattern with namePattern (both must hold)", () => {
    expect(matchesFilter(enemy, { pathPattern: "/enemy/", namePattern: "^update$" })).toBe(true);
    expect(matchesFilter(enemy, { pathPattern: "/enemy/", namePattern: "^draw$" })).toBe(false);
    // Same name in the wrong directory fails on the path leg.
    expect(matchesFilter(render, { pathPattern: "/enemy/", namePattern: "^update$" })).toBe(false);
  });

  it("an empty filter still matches every node", () => {
    expect(matchesFilter(enemy, {})).toBe(true);
  });

  it("selectNodes filters a collection by path", () => {
    const got = selectNodes([enemy, render], { pathPattern: "/render/" });
    expect(got.map((n) => n.sourceRange.filePath)).toEqual([render.sourceRange.filePath]);
  });
});
