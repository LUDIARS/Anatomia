/**
 * Fix B — AST-aware perturbation helpers for the measurement harness.
 *
 * These lock the two TypeScript bugs the naive `str.replace("{", ...)` harness
 * hit:
 *   1. object-type return annotations put a `{` BEFORE the body, so a naive
 *      probe lands in the type annotation and changes the parsed signature;
 *   2. re-parsing a snippet standalone makes `extractFunctions(...)[0]` return an
 *      INNER arrow function instead of the outer one.
 *
 * The helpers locate the body via the AST and re-identify the function by
 * name + occurrence, so a comment probe is a true same-meaning edit (hash
 * unchanged) even for object-return-typed TS functions, and the OUTER function
 * is the one measured.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../parser.js";
import { extractFunctions } from "../extract.js";
import {
  pickFunction,
  insertBodyComment,
  hashNamedSnippet,
} from "../measure.js";

describe("Fix B — pickFunction selects the OUTER function, not an inner arrow", () => {
  it("returns the outer function_declaration over a nested arrow function", async () => {
    const src =
      "function outer(xs: number[]): number[] {\n" +
      "  const f = (y: number): number => { return y + 1; };\n" +
      "  return xs.map(f);\n" +
      "}";
    const tree = await parse(src, "typescript");
    const fns = extractFunctions(tree, src, "/x.ts");
    const picked = pickFunction(fns);
    tree.delete();
    expect(picked).not.toBeNull();
    expect(picked!.name).toBe("outer");
  });

  it("disambiguates same-named functions by occurrence (source order)", async () => {
    const src =
      "function dup(): number { return 1; }\n" +
      "function dup(): number { return 2; }";
    const tree = await parse(src, "typescript");
    const fns = extractFunctions(tree, src, "/x.ts");
    const first = pickFunction(fns, "dup", 0);
    const second = pickFunction(fns, "dup", 1);
    tree.delete();
    expect(first!.sourceRange.start.line).toBe(0);
    expect(second!.sourceRange.start.line).toBe(1);
  });
});

describe("Fix B — insertBodyComment lands in the body, not an object-type return annotation", () => {
  // The bug: the FIRST `{` is inside the return-type annotation `: { x: number }`.
  const objReturn =
    "function makePoint(x: number, y: number): { x: number; y: number } {\n" +
    "  const p = { x, y };\n" +
    "  return p;\n" +
    "}";

  it("inserts the probe AFTER the body's opening brace (not the type annotation's)", async () => {
    const out = await insertBodyComment(objReturn, "typescript", "makePoint");
    expect(out).not.toBeNull();
    // The probe must appear after `) {` that opens the body, i.e. after the
    // return-type object literal. The type annotation `{ x: number; y: number }`
    // must remain intact (its first `{` untouched).
    expect(out!).toContain("{ x: number; y: number }");
    // The probe text is present exactly once.
    expect((out!.match(/anatomia-probe/g) ?? []).length).toBe(1);
    // The probe sits inside the body: it appears AFTER the return-type close `} {`.
    const probeIdx = out!.indexOf("anatomia-probe");
    const bodyOpenIdx = out!.indexOf("} {"); // close of return-type obj, then body `{`
    expect(bodyOpenIdx).toBeGreaterThanOrEqual(0);
    expect(probeIdx).toBeGreaterThan(bodyOpenIdx);
  });

  it("a body comment is a same-meaning edit → hash unchanged for an object-return-typed fn", async () => {
    const original = await hashNamedSnippet(objReturn, "typescript", "makePoint", "/x.ts");
    const perturbed = await insertBodyComment(objReturn, "typescript", "makePoint");
    expect(perturbed).not.toBeNull();
    const after = await hashNamedSnippet(perturbed!, "typescript", "makePoint", "/x.ts");
    expect(original).not.toBeNull();
    expect(after).toBe(original);
  });

  it("the naive first-`{` probe WOULD corrupt the return type (regression guard)", () => {
    // Demonstrates why AST-awareness is needed: the naive transform lands in the
    // type annotation, not the body.
    const naive =
      objReturn.slice(0, objReturn.indexOf("{") + 1) +
      " /* probe */ " +
      objReturn.slice(objReturn.indexOf("{") + 1);
    // Naive probe corrupts the object return type.
    expect(naive).toContain("{ /* probe */  x: number");
  });
});

describe("Fix B — C++ same-meaning comment edit keeps the hash (no regression)", () => {
  it("comment inside a C++ body does not change the hash", async () => {
    const cpp = "int add(int a, int b) {\n  int r = a + b;\n  return r;\n}";
    const before = await hashNamedSnippet(cpp, "cpp", "add", "/x.cpp");
    const perturbed = await insertBodyComment(cpp, "cpp", "add");
    expect(perturbed).not.toBeNull();
    const after = await hashNamedSnippet(perturbed!, "cpp", "add", "/x.cpp");
    expect(after).toBe(before);
  });
});
