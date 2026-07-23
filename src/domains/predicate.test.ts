/**
 * Tests for NodeFilter matching (predicate.ts), focused on path and stable
 * function-signature evidence.
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

  it("matches normalized signature shapes and fails closed when facts are absent", () => {
    const filter = { signatureShapePattern: "^\\(sig Enemy::update int\\)$" };
    expect(matchesFilter({ ...enemy, signatureShape: "(sig Enemy::update int)" }, filter)).toBe(true);
    expect(matchesFilter({ ...enemy, signatureShape: "(sig Enemy::update double)" }, filter)).toBe(false);
    expect(matchesFilter(enemy, filter)).toBe(false);
  });

  it("distinguishes qualified methods and free functions through the shape", () => {
    const filter = { signatureShapePattern: "Enemy::update" };
    expect(matchesFilter({ ...enemy, signatureShape: "(sig Enemy::update int)" }, filter)).toBe(true);
    expect(matchesFilter({ ...enemy, signatureShape: "(sig Renderer::update int)" }, filter)).toBe(false);
    expect(matchesFilter({ ...enemy, signatureShape: "(sig update int)" }, filter)).toBe(false);
  });

  it("an empty filter still matches every node", () => {
    expect(matchesFilter(enemy, {})).toBe(true);
  });

  it("selectNodes filters a collection by path", () => {
    const got = selectNodes([enemy, render], { pathPattern: "/render/" });
    expect(got.map((n) => n.sourceRange.filePath)).toEqual([render.sourceRange.filePath]);
  });
});
