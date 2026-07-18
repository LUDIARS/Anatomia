/**
 * buildReview — deterministic structural review assembled from rules × domain
 * graph × AST graph. Exercises each finding kind on a small real repo.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "../../core.js";
import { buildReview } from "../build.js";
import { formatReview } from "../format.js";
import type { AnalysisContext } from "../../core.js";

let repo: string;
let ctx: AnalysisContext;

const ONTOLOGY = JSON.stringify([
  {
    name: "no-skill-to-render",
    description: "skill/ must not call render/",
    presetRules: [
      { preset: "forbiddenCall", params: { callerPattern: "/skill/", calleePattern: "/render/", by: "path", kind: "calls" } },
    ],
    templateRules: [],
  },
]);

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "anatomia-review-"));
  for (const d of ["src/render", "src/skill", "src/util", "src/a", "src/b", "onto"]) {
    await mkdir(join(repo, d), { recursive: true });
  }
  await writeFile(join(repo, "src/render/r.cpp"), "void make_ortho() { return; }\n");
  // skill -> render : a rule violation.
  await writeFile(join(repo, "src/skill/s.cpp"), "void fire() { make_ortho(); }\n");
  // mutual recursion : a cycle.
  await writeFile(join(repo, "src/util/u.cpp"), "void pong();\nvoid ping() { pong(); }\nvoid pong() { ping(); }\n");
  // identical function in two files : a structural duplicate (same Anchor ID).
  await writeFile(join(repo, "src/a/dup.cpp"), "int helper() { return 42; }\n");
  await writeFile(join(repo, "src/b/dup.cpp"), "int helper() { return 42; }\n");
  await writeFile(join(repo, "onto/rules.json"), ONTOLOGY);
  ctx = await analyze(join(repo, "src"), { quiet: true, pluginDir: join(repo, "onto") });
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("buildReview", () => {
  it("reports the rule violation with source locations", async () => {
    const r = await buildReview(ctx);
    const v = r.violations.find((x) => x.rule.startsWith("no-skill-to-render/"));
    expect(v).toBeTruthy();
    expect(v!.evidence).toContain("make_ortho");
    expect(v!.locations.some((l) => l.file.includes("skill/") || l.file.includes("render/"))).toBe(true);
    expect(v!.locations.every((l) => l.line > 0)).toBe(true);
  });

  it("detects the dependency cycle (ping/pong)", async () => {
    const r = await buildReview(ctx);
    const names = r.cycles.flat().map((l) => l.name);
    expect(names).toContain("ping");
    expect(names).toContain("pong");
  });

  it("detects the structural duplicate across two files", async () => {
    const r = await buildReview(ctx);
    const dup = r.structuralDup.find((d) => d.name === "helper");
    expect(dup).toBeTruthy();
    expect(dup!.copies.length).toBe(2);
    const files = dup!.copies.map((c) => c.file).sort();
    expect(files[0]).toContain("a/dup.cpp");
    expect(files[1]).toContain("b/dup.cpp");
  });

  it("lists coupling hotspots and a consistent summary", async () => {
    const r = await buildReview(ctx);
    expect(Array.isArray(r.hotspots)).toBe(true);
    expect(r.summary.violations).toBe(r.violations.length);
    expect(r.summary.structuralDup).toBe(r.structuralDup.length);
    expect(r.summary.cycles).toBe(r.cycles.length);
  });

  it("has no spec gaps when there is no spec (gap detection only with clauses)", async () => {
    const r = await buildReview(ctx);
    expect(r.specGaps).toEqual([]);
    expect(r.summary.specGaps).toBe(0);
  });

  it("is deterministic (same context → identical report)", async () => {
    const a = await buildReview(ctx);
    const b = await buildReview(ctx);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("formatReview renders the sections as text", async () => {
    const text = formatReview(await buildReview(ctx));
    expect(text).toContain("Rule violations");
    expect(text).toContain("Structural duplicates");
    expect(text).toContain("Dependency cycles");
  });
});

describe("buildReview Unity lifecycle", () => {
  it("does not report engine-invoked MonoBehaviour callbacks as orphans", async () => {
    const unity = await mkdtemp(join(tmpdir(), "anatomia-review-unity-"));
    try {
      await mkdir(join(unity, "Assets"), { recursive: true });
      await mkdir(join(unity, "ProjectSettings"), { recursive: true });
      await writeFile(
        join(unity, "ProjectSettings", "ProjectVersion.txt"),
        "m_EditorVersion: 2021.3.0f1\n",
      );
      await writeFile(
        join(unity, "Assets", "Player.cs"),
        [
          "class BaseBehaviour : MonoBehaviour {}",
          "class Player : BaseBehaviour {",
          "  void Update() {}",
          "  void Helper() {}",
          "}",
        ].join("\n"),
      );
      const unityCtx = await analyze(unity, { quiet: true });
      const review = await buildReview(unityCtx);
      expect(review.orphans.map((entry) => entry.name)).toContain("Helper");
      expect(review.orphans.map((entry) => entry.name)).not.toContain("Update");
    } finally {
      await rm(unity, { recursive: true, force: true });
    }
  });
});
