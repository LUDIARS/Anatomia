/**
 * End-to-end: buildVerdict evaluates architecture rules against the DIFF-
 * augmented graph, so a brand-new call from the changed code into a forbidden
 * layer is surfaced — invisible before, when verify evaluated the unmodified
 * graph and the new function's edges did not exist in it.
 *
 * Domain rules default to `warn`, so the rule_conformance gate stays pass=true
 * and reports the violation as an advisory. The assertion is that the advisory
 * appears at all — which only happens if the augmented graph carried the new
 * data/ -> render/ edge.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze, buildVerdict } from "../core.js";
import type { AnalysisContext } from "../core.js";

let repo: string;
let ctx: AnalysisContext;

const ONTOLOGY = JSON.stringify([
  {
    name: "no-data-to-render",
    description: "data/ must not call render/",
    presetRules: [
      {
        preset: "forbiddenCall",
        params: { callerPattern: "/data/", calleePattern: "/render/", by: "path", kind: "calls" },
      },
    ],
    templateRules: [],
  },
]);

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "anatomia-verifyaug-"));
  await mkdir(join(repo, "src", "render"), { recursive: true });
  await mkdir(join(repo, "src", "data"), { recursive: true });
  await mkdir(join(repo, "onto"), { recursive: true });
  await writeFile(join(repo, "src", "render", "r.cpp"), "void draw_sprite() { return; }\n");
  await writeFile(join(repo, "src", "data", "d.cpp"), "int dummy() { return 0; }\n");
  await writeFile(join(repo, "onto", "rules.json"), ONTOLOGY);
  ctx = await analyze(join(repo, "src"), { quiet: true, pluginDir: join(repo, "onto") });
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("buildVerdict over diff-augmented graph", () => {
  it("detects the rule + compiles it onto ctx.rules", () => {
    expect((ctx.rules ?? []).some((r) => r.id.startsWith("no-data-to-render/"))).toBe(true);
  });

  it("surfaces a new data/ -> render/ call as a rule_conformance advisory", async () => {
    // A new data-layer function calling the existing render function.
    const diff = [
      "--- a/src/data/d.cpp",
      "+++ b/src/data/d.cpp",
      "@@ -1,1 +1,4 @@",
      " int dummy() { return 0; }",
      "+void touch_render() {",
      "+  draw_sprite();",
      "+}",
    ].join("\n");

    const verdict = await buildVerdict(ctx, diff, "src/data/d.cpp");
    const rc = verdict.gates.find((g) => g.gate === "rule_conformance")!;
    // warn severity → gate still passes, but the violation is reported.
    expect(rc.pass).toBe(true);
    expect(rc.suggestion ?? "").toContain("no-data-to-render");
    expect(rc.suggestion ?? "").toContain("draw_sprite");
  });

  it("does not flag a diff that stays within its layer", async () => {
    const diff = [
      "--- a/src/data/d.cpp",
      "+++ b/src/data/d.cpp",
      "@@ -1,1 +1,2 @@",
      " int dummy() { return 0; }",
      "+int dummy2() { return dummy(); }",
    ].join("\n");

    const verdict = await buildVerdict(ctx, diff, "src/data/d.cpp");
    const rc = verdict.gates.find((g) => g.gate === "rule_conformance")!;
    expect(rc.pass).toBe(true);
    expect(rc.suggestion ?? "").not.toContain("no-data-to-render");
  });

  it("evaluates path-based rules for every file in a multi-file diff", async () => {
    const diff = [
      "diff --git a/src/render/r.cpp b/src/render/r.cpp",
      "--- a/src/render/r.cpp",
      "+++ b/src/render/r.cpp",
      "@@ -1,1 +1,2 @@",
      " void draw_sprite() { return; }",
      "+void draw_more() { draw_sprite(); }",
      "diff --git a/src/data/d.cpp b/src/data/d.cpp",
      "--- a/src/data/d.cpp",
      "+++ b/src/data/d.cpp",
      "@@ -1,1 +1,4 @@",
      " int dummy() { return 0; }",
      "+void touch_render_multi() {",
      "+  draw_sprite();",
      "+}",
    ].join("\n");

    const verdict = await buildVerdict(ctx, diff);
    const rc = verdict.gates.find((g) => g.gate === "rule_conformance")!;
    expect(rc.suggestion ?? "").toContain("no-data-to-render");
    expect(rc.suggestion ?? "").toContain("touch_render_multi");
  });
});
