/**
 * buildVerdict + `--plan`: the advisory plan_conformance gate is appended ONCE
 * over the whole diff, and never changes the verdict's pass/fail.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyze, buildVerdict } from "../core.js";
import { PLAN_VERSION, type Plan } from "../supply/plan/types.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mini");

function planFor(plannedPaths: string[]): Plan {
  return {
    version: PLAN_VERSION,
    task: "新しい Action 種別を足す",
    taskHash: "deadbeefdeadbeef",
    generatedAt: "2026-09-05T00:00:00.000Z",
    repos: ["fixture"],
    source: "llm",
    items: [
      {
        id: "fixture/action",
        dependsOn: [],
        uxCritical: false,
        repo: "fixture",
        domain: "action",
        status: "existing",
        responsibility: "Action 種別の追加",
        plannedPaths,
        ownedPathPatterns: [],
        neededTypes: [],
        layer: "src",
        dataDefs: [],
        duplicates: [],
        exemplar: null,
      },
    ],
    unresolved: [],
    questions: [],
    notes: [],
    layerWarnings: [],
  };
}

const DIFF = [
  "diff --git a/src/effect.cpp b/src/effect.cpp",
  "--- a/src/effect.cpp",
  "+++ b/src/effect.cpp",
  "@@ -0,0 +1,3 @@",
  "+void newEffect(int kind) {",
  "+  int total = kind;",
  "+}",
  "diff --git a/tools/unrelated.cpp b/tools/unrelated.cpp",
  "--- a/tools/unrelated.cpp",
  "+++ b/tools/unrelated.cpp",
  "@@ -0,0 +1,3 @@",
  "+void helper(int kind) {",
  "+  int total = kind;",
  "+}",
].join("\n");

describe("verify --plan", () => {
  it("adds no gate when no plan is given", async () => {
    const ctx = await analyze(FIXTURE, { quiet: true });
    const verdict = await buildVerdict(ctx, DIFF);
    expect(verdict.gates.map((g) => g.gate)).not.toContain("plan_conformance");
  });

  it("reports one plan_conformance result for a multi-file diff", async () => {
    const ctx = await analyze(FIXTURE, { quiet: true });
    const verdict = await buildVerdict(ctx, DIFF, undefined, {
      plan: planFor(["src/effect.cpp"]),
    });
    const gates = verdict.gates.filter((g) => g.gate === "plan_conformance");
    expect(gates).toHaveLength(1);
    expect(gates[0]!.pass).toBe(false);
    expect(gates[0]!.suggestion).toContain("tools/unrelated.cpp");
    expect(gates[0]!.suggestion).not.toContain("src/effect.cpp");
  });

  it("is advisory: an off-plan file never flips the verdict", async () => {
    const ctx = await analyze(FIXTURE, { quiet: true });
    const withoutPlan = await buildVerdict(ctx, DIFF);
    const withPlan = await buildVerdict(ctx, DIFF, undefined, { plan: planFor([]) });
    expect(withPlan.pass).toBe(withoutPlan.pass);
    expect(withPlan.suggestion).toContain("[warn plan_conformance]");
  });

  it("passes when every changed file was planned", async () => {
    const ctx = await analyze(FIXTURE, { quiet: true });
    const verdict = await buildVerdict(ctx, DIFF, undefined, {
      plan: planFor(["src/effect.cpp", "tools/unrelated.cpp"]),
    });
    const gate = verdict.gates.find((g) => g.gate === "plan_conformance")!;
    expect(gate.pass).toBe(true);
    expect(gate.suggestion).toBeNull();
  });

  it("reports an unplanned deleted file by its pre-image path", async () => {
    const ctx = await analyze(FIXTURE, { quiet: true });
    const deletion = [
      "diff --git a/tools/removed.cpp b/tools/removed.cpp",
      "--- a/tools/removed.cpp",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-void removed() {}",
    ].join("\n");
    const verdict = await buildVerdict(ctx, deletion, undefined, { plan: planFor([]) });
    const gate = verdict.gates.find((g) => g.gate === "plan_conformance")!;
    expect(gate.pass).toBe(false);
    expect(gate.suggestion).toContain("tools/removed.cpp");
  });
});
