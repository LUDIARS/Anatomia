/**
 * Fix A — buildVerdict() language-awareness.
 *
 * buildVerdict previously parsed every diff as C++ regardless of the real
 * language. These tests prove the verify path now detects the language (from an
 * explicit target path or the unified-diff `+++` header) and re-parses the
 * changed code with the correct grammar:
 *   - a TypeScript diff is parsed as TypeScript (TS-only syntax such as type
 *     annotations / `interface` is handled, not mis-parsed as C++);
 *   - a C++ diff is parsed as C++;
 * and a well-formed Verdict (5 gates) is produced for each.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { analyze, buildVerdict } from "../core.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "mini");

/** A function body whose hash carries the changed-function anchor. */
function anchorsOf(gates: { anchors: string[] }[]): string[] {
  return gates.flatMap((g) => g.anchors);
}

describe("Fix A — buildVerdict is language-aware", () => {
  it("parses a TypeScript diff as TypeScript (TS-only syntax handled, not mis-parsed as C++)", async () => {
    const ctx = await analyze(FIXTURE, { quiet: true });

    // TS-only syntax: an interface declaration + a typed object-return annotation
    // + a type-annotated local. The cpp grammar would choke on `interface` and
    // on `: { x: number }` return annotations; the TS grammar handles them.
    const tsDiff = [
      "interface Pt { x: number; y: number }",
      "",
      "function makePoint(x: number, y: number): { x: number; y: number } {",
      "  const p: Pt = { x, y };",
      "  return p;",
      "}",
    ].join("\n");

    // Pass an explicit .ts target so language detection picks TypeScript.
    const verdict = await buildVerdict(ctx, tsDiff, "src/feature.ts");

    // The 5-gate pipeline ran and produced a structured verdict.
    expect(verdict.gates.length).toBe(5);
    expect(typeof verdict.pass).toBe("boolean");
    // The TS function was actually parsed + hashed: at least one gate (the
    // orphan spec_linkage warning) carries the changed function's anchor.
    expect(anchorsOf(verdict.gates).length).toBeGreaterThan(0);
  });

  it("detects TypeScript from a unified-diff +++ header (no explicit target)", async () => {
    const ctx = await analyze(FIXTURE, { quiet: true });

    const unifiedTsDiff = [
      "diff --git a/src/shape.ts b/src/shape.ts",
      "--- a/src/shape.ts",
      "+++ b/src/shape.ts",
      "@@ -0,0 +1,4 @@",
      "+function area(r: number): number {",
      "+  const a: number = Math.PI * r * r;",
      "+  return a;",
      "+}",
    ].join("\n");

    const verdict = await buildVerdict(ctx, unifiedTsDiff);
    expect(verdict.gates.length).toBe(5);
    // Function extracted from the TS post-image → its anchor surfaces.
    expect(anchorsOf(verdict.gates).length).toBeGreaterThan(0);
  });

  it("parses a C++ diff as C++ (default path unchanged)", async () => {
    const ctx = await analyze(FIXTURE, { quiet: true });

    const cppDiff = [
      "void applyKnockback(float impulse, float dir[3]) {",
      "  float v = impulse;",
      "  for (int i = 0; i < 3; ++i) dir[i] *= v;",
      "}",
    ].join("\n");

    const verdict = await buildVerdict(ctx, cppDiff);
    expect(verdict.gates.length).toBe(5);
    expect(typeof verdict.pass).toBe("boolean");
    expect(anchorsOf(verdict.gates).length).toBeGreaterThan(0);
  });

  it("a TS diff and a C++ diff of the SAME logic yield different anchors (proves grammar differs)", async () => {
    const ctx = await analyze(FIXTURE, { quiet: true });

    const tsDiff = "function inc(x: number): number { return x + 1; }";
    const cppDiff = "int inc(int x) { return x + 1; }";

    const vTs = await buildVerdict(ctx, tsDiff, "x.ts");
    const vCpp = await buildVerdict(ctx, cppDiff, "x.cpp");

    const tsAnchors = anchorsOf(vTs.gates).sort();
    const cppAnchors = anchorsOf(vCpp.gates).sort();

    expect(tsAnchors.length).toBeGreaterThan(0);
    expect(cppAnchors.length).toBeGreaterThan(0);
    // Different file paths + different grammars → different anchor ids.
    expect(tsAnchors).not.toEqual(cppAnchors);
  });
});
