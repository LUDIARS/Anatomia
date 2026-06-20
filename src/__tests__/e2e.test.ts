/**
 * T43/T44 — End-to-end wiring + integration test.
 *
 * Exercises the whole G1→G5 chain through the public `analyze()` entry point,
 * plus the adapter-facing helpers `buildContextBundle` / `buildVerdict` /
 * `getImpactRadius` (the MCP surface: context / verify / impact).
 *
 * Two corpora:
 *   1. a tiny self-contained fixture (always runs) — proves the chain wires.
 *   2. a subset of the real AdventureCube repo (skipped if absent) — proves the
 *      chain survives real C++ (templates, macros, STL, overloads).
 *
 * The AdventureCube assertions are intentionally loose (non-empty graph,
 * detection attempted) — exact numbers live in docs/measurement-report.md, which
 * is produced by scripts/measure.mjs, not asserted here (real numbers drift).
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  analyze,
  buildContextBundle,
  buildVerdict,
  getImpactRadius,
} from "../core.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "mini");

// A subset of AdventureCube covering its core domains (Skill→Action, combat,
// equipment). Skipped automatically when the repo is not checked out here.
const AC_SUBSET = "E:/Document/Ars/AdventureCube/src/combat";

describe("analyze() — mini fixture (always runs)", () => {
  it("runs the full chain and produces a non-empty graph", async () => {
    const ctx = await analyze(FIXTURE, { quiet: true });

    // Discovery + parse + extract + hash.
    expect(ctx.files.length).toBeGreaterThan(0);
    expect(ctx.functions.length).toBeGreaterThan(0);
    // Every extracted function got an Anchor ID (normalize→hash succeeded).
    expect(ctx.functions.every((f) => f.id !== null)).toBe(true);

    // Code graph (G2).
    const nodes = await ctx.graph.allNodes();
    expect(nodes.length).toBeGreaterThan(0);

    // Domain detection attempted (G3) — builtin ontology always loads.
    expect(Array.isArray(ctx.domains)).toBe(true);
    expect(ctx.domains!.length).toBeGreaterThan(0);

    // Spec linking (G4) — the fixture ships a spec/Mini.md.
    expect(ctx.specClauses!.length).toBeGreaterThan(0);
    expect(Array.isArray(ctx.links)).toBe(true);

    // Nothing should have been skipped in the clean fixture.
    expect(ctx.skipped!.length).toBe(0);
  });

  it("context(task) → a deterministic ContextBundle", async () => {
    const ctx = await analyze(FIXTURE, { quiet: true });
    const bundle1 = await buildContextBundle(ctx, { task: "add a new Action kind" });
    const bundle2 = await buildContextBundle(ctx, { task: "add a new Action kind" });

    // Bundle is well-formed.
    expect(bundle1).toHaveProperty("landingAnchor");
    expect(bundle1).toHaveProperty("exemplars");
    expect(bundle1.specClauses.length).toBeGreaterThan(0);

    // Determinism: same input → byte-identical bundle.
    expect(JSON.stringify(bundle1)).toBe(JSON.stringify(bundle2));
  });

  it("verify(diff) → a Verdict end-to-end", async () => {
    const ctx = await analyze(FIXTURE, { quiet: true });
    const diff = `
      void newEffect(int kind) {
        int total = 0;
        for (int i = 0; i < kind; ++i) total += i;
      }
    `;
    const verdict = await buildVerdict(ctx, diff);

    expect(verdict).toHaveProperty("pass");
    expect(typeof verdict.pass).toBe("boolean");
    expect(Array.isArray(verdict.gates)).toBe(true);
    // The 5-gate pipeline ran.
    expect(verdict.gates.length).toBe(5);
  });

  it("impact(anchor) → reachable set", async () => {
    const ctx = await analyze(FIXTURE, { quiet: true });
    const withId = ctx.functions.find((f) => f.id !== null);
    expect(withId).toBeDefined();
    const radius = await getImpactRadius(ctx, withId!.id!);
    expect(Array.isArray(radius)).toBe(true);
  });

  // Regression: analyze() frees every parse tree's WASM memory after phase 4
  // (the last bodyAst reader) so a warm server doesn't pin every cached
  // project's trees until the 2GB tree-sitter heap aborts. The freeing must
  // happen AFTER edge extraction (phase 2) and domain template matching
  // (phase 4), and must not disturb anything that runs off the graph.
  it("frees parse trees but leaves graph edges + domains intact", async () => {
    const ctx = await analyze(FIXTURE, { quiet: true });

    // Phase-2 bodyAst consumer ran before the trees were freed: call/read/write
    // edges were extracted into the graph.
    const nodes = await ctx.graph.allNodes();
    let edgeCount = 0;
    for (const n of nodes) edgeCount += (await ctx.graph.edgesFrom(n.id)).length;
    expect(edgeCount).toBeGreaterThan(0);

    // Phase-4 bodyAst consumer (domain template matching) ran before freeing.
    expect(ctx.domains!.length).toBeGreaterThan(0);

    // Post-analyze graph operations still work after trees are freed — they read
    // plain FileNode/edge data, never bodyAst.
    const radius = await getImpactRadius(ctx, ctx.functions.find((f) => f.id)!.id!);
    expect(Array.isArray(radius)).toBe(true);
  });
});

const acDescribe = existsSync(AC_SUBSET) ? describe : describe.skip;

acDescribe("analyze() — AdventureCube subset (real C++)", () => {
  it(
    "completes on real C++ and produces a non-empty graph + domain detection",
    async () => {
      const ctx = await analyze(AC_SUBSET, { quiet: true });

      // Real parse must extract a meaningful number of functions.
      expect(ctx.functions.length).toBeGreaterThan(50);
      expect(ctx.functions.every((f) => f.id !== null)).toBe(true);

      const nodes = await ctx.graph.allNodes();
      expect(nodes.length).toBeGreaterThan(0);

      // Domain detection was attempted on real code (results may include
      // zero-implementor domains — that is a valid outcome, not a crash).
      expect(Array.isArray(ctx.domains)).toBe(true);
      expect(ctx.domains!.length).toBeGreaterThan(0);
    },
    60_000,
  );

  it(
    "context/verify run end-to-end on the real subset",
    async () => {
      const ctx = await analyze(AC_SUBSET, { quiet: true });

      const bundle = await buildContextBundle(ctx, {
        task: "add a new combat action that applies knockback",
      });
      expect(bundle).toHaveProperty("exemplars");
      expect(bundle.exemplars.length).toBeGreaterThan(0);

      const diff = `
        void applyKnockback(float impulse) {
          float v = impulse * 2.0f;
          (void)v;
        }
      `;
      const verdict = await buildVerdict(ctx, diff);
      expect(verdict.gates.length).toBe(5);
      expect(typeof verdict.pass).toBe("boolean");
    },
    60_000,
  );
});
