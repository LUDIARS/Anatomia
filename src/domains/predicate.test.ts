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

// `pr-review --repo <absolute>` hands absolute node paths to membership patterns
// written repo-relative (`^src/...`); they matched nothing and the PR came back
// "target domain missing" while `--repo .` passed (Actio eb08b6f4).
describe("matchesFilter pathPattern with a repo root", () => {
  const absolute = node("handle", "E:/Document/Ars/Actio/src/routes/tasks.ts");
  const windows = node("handle", "E:\\Document\\Ars\\Actio\\src\\routes\\tasks.ts");
  const relative = node("handle", "src/routes/tasks.ts");
  const repoRoot = "E:/Document/Ars/Actio";

  it("matches a ^-anchored pattern against the repo-relative path", () => {
    expect(matchesFilter(absolute, { pathPattern: "^src/routes/" })).toBe(false);
    expect(matchesFilter(absolute, { pathPattern: "^src/routes/" }, { repoRoot })).toBe(true);
    expect(matchesFilter(windows, { pathPattern: "^src/routes/" }, { repoRoot: "e:\\document\\ars\\actio" })).toBe(true);
  });

  it("gives the same answer for an absolute and a relative checkout", () => {
    expect(matchesFilter(relative, { pathPattern: "^src/routes/" }, { repoRoot: "." })).toBe(true);
    expect(matchesFilter(absolute, { pathPattern: "^src/routes/" }, { repoRoot })).toBe(true);
  });

  it("keeps segment patterns working against the absolute path", () => {
    expect(matchesFilter(absolute, { pathPattern: "/Actio/src/" }, { repoRoot })).toBe(true);
    expect(matchesFilter(absolute, { pathPattern: "(^|/)src/routes/" }, { repoRoot })).toBe(true);
  });

  it("does not match files outside the pattern even when relativised", () => {
    expect(matchesFilter(absolute, { pathPattern: "^src/db/" }, { repoRoot })).toBe(false);
    expect(selectNodes([absolute], { pathPattern: "^src/routes/" }, { repoRoot })).toEqual([absolute]);
  });
});
