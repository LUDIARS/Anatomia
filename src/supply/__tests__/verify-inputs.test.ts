/**
 * verify-inputs.ts — derivation of the thresholds/siblings DiffInput fields
 * that core.buildVerdict feeds the coupling_delta / convention_drift gates.
 * Without them both gates no-op, so the derivation itself must be correct
 * and deterministic.
 */

import { describe, it, expect } from "vitest";
import { membershipOf, selectSiblings, verifyThresholds } from "../verify-inputs.js";
import { METRIC_KEYS } from "../metrics.js";
import { buildFromSource } from "./helpers.js";
import type { AnalysisContext } from "../../core.js";
import type { AnchorId, FunctionNode } from "../../types.js";

function fn(id: string, name: string, filePath: string): FunctionNode {
  return {
    id: id as AnchorId,
    name,
    signature: `void ${name}()`,
    sourceRange: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 }, filePath },
    bodyAst: {} as FunctionNode["bodyAst"],
  };
}

async function miniCtx(functions: FunctionNode[]): Promise<AnalysisContext> {
  const { graph, file } = await buildFromSource(`void b() {} void a() { b(); }`);
  return { repoPath: "/repo", graph, files: [file], functions };
}

describe("selectSiblings", () => {
  const all = [
    fn("f1", "applyBurn", "/repo/src/effect.cpp"),
    fn("f2", "applyFreeze", "/repo/src/effect.cpp"),
    fn("f3", "applyPoison", "/repo/src/other.cpp"),
    fn("f4", "unrelated", "/repo/lib/away.cpp"),
  ];

  it("excludes the changed names and widens when the remaining sample is small", async () => {
    const ctx = await miniCtx(all);
    const changed = [fn("n1", "applyBurn", "src/effect.cpp")];
    const got = selectSiblings(ctx, "src/effect.cpp", changed);
    // applyBurn (changed) is excluded; the single remaining same-file sibling
    // is below the minimum sample, so the directory sibling joins it.
    expect(got.map((f) => f.name)).toEqual(["applyFreeze", "applyPoison"]);
  });

  it("widens to the directory when the file sample is too small", async () => {
    const ctx = await miniCtx(all);
    const got = selectSiblings(ctx, "src/effect.cpp", [fn("n1", "newThing", "src/effect.cpp")]);
    // effect.cpp alone has 2 candidates? no — both apply* are in effect.cpp, so
    // the same-file sample (2) is enough and other.cpp must NOT be included.
    expect(got.map((f) => f.name)).toEqual(["applyBurn", "applyFreeze"]);

    // A file with a single function widens to its directory (other.cpp -> src/).
    const widened = selectSiblings(ctx, "src/other.cpp", [fn("n2", "newThing", "src/other.cpp")]);
    expect(widened.map((f) => f.name)).toEqual(["applyBurn", "applyFreeze", "applyPoison"]);
  });

  it("matches Windows-style absolute paths against repo-relative targets", async () => {
    const ctx = await miniCtx([
      fn("f1", "alpha", "C:\\repo\\src\\a.cpp"),
      fn("f2", "beta", "C:\\repo\\src\\a.cpp"),
    ]);
    ctx.repoPath = "C:\\repo";
    const got = selectSiblings(ctx, "src/a.cpp", [fn("n1", "gamma", "src/a.cpp")]);
    expect(got.map((f) => f.name)).toEqual(["alpha", "beta"]);
  });

  it("returns no siblings without a target path (raw snippet verify)", async () => {
    const ctx = await miniCtx(all);
    expect(selectSiblings(ctx, undefined, [])).toEqual([]);
  });
});

describe("verifyThresholds", () => {
  it("derives thresholds for every metric key and memoizes per ctx", async () => {
    const ctx = await miniCtx([]);
    const first = await verifyThresholds(ctx);
    for (const key of METRIC_KEYS) {
      expect(first[key].n).toBeGreaterThan(0);
      expect(first[key].upper).toBeGreaterThanOrEqual(first[key].median);
    }
    // Same ctx object -> same memoized promise result (no recompute).
    const second = await verifyThresholds(ctx);
    expect(second).toBe(first);
    // A different ctx derives independently.
    const other = await verifyThresholds(await miniCtx([]));
    expect(other).not.toBe(first);
  });
});

describe("membershipOf", () => {
  it("maps detection results to domain -> implementors", async () => {
    const ctx = await miniCtx([]);
    ctx.domains = [
      { domain: "combat", implementors: ["x" as AnchorId], violations: [], conforms: true },
    ];
    expect([...membershipOf(ctx).entries()]).toEqual([["combat", ["x"]]]);
  });
});
