/**
 * T28 — Tests for bundle.ts, including the determinism contract.
 */

import { describe, it, expect } from "vitest";
import { assembleBundle, orderBundleSegments, bundleContentKey } from "../bundle.js";
import type { BundleInputs } from "../bundle.js";
import type { AnchorId, FunctionNode, Rule, SpecClause } from "../../types.js";

function a(id: string): AnchorId {
  return id as unknown as AnchorId;
}

function fn(id: string, name: string): FunctionNode {
  return {
    id: a(id),
    name,
    signature: `void ${name}()`,
    sourceRange: { start: { line: 1, column: 0 }, end: { line: 2, column: 0 }, filePath: `/${name}.cpp` },
    // bodyAst is not touched by the bundle; cast a placeholder.
    bodyAst: {} as FunctionNode["bodyAst"],
  };
}

function rule(id: string): Rule {
  return {
    id,
    scope: "global",
    description: `rule ${id}`,
    predicate: { type: "NoCycle", scope: {} },
    severity: "warn",
  };
}

function clause(id: string): SpecClause {
  return { id, sourceFile: "DESIGN.md", heading: `§${id}`, text: "x", embedding: null };
}

/** An UNSORTED input set; assembleBundle must sort it. */
function makeInputs(): BundleInputs {
  return {
    landingAnchors: [a("c"), a("a"), a("b")],
    rules: [rule("r2"), rule("r1"), rule("r1") /* dup */],
    specClauses: [clause("s2"), clause("s1")],
    exemplars: [fn("f2", "Beta"), fn("f1", "Alpha")],
    impactRadius: [a("z"), a("x"), a("y")],
    existingMechanics: ["combat", "ai", "combat" /* dup */],
  };
}

describe("T28 assembleBundle", () => {
  it("assembles all 6 elements", () => {
    const { bundle } = assembleBundle(makeInputs());
    expect(bundle.landingAnchor).not.toBeNull();
    expect(bundle.applicableRules.length).toBeGreaterThan(0);
    expect(bundle.specClauses.length).toBe(2);
    expect(bundle.exemplars.length).toBe(2);
    expect(bundle.impactRadius.length).toBe(3);
    expect(bundle.existingMechanics.length).toBe(2); // deduped
  });

  it("sorts every collection and dedups", () => {
    const { bundle } = assembleBundle(makeInputs());
    expect(bundle.applicableRules.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(bundle.specClauses.map((c) => c.id)).toEqual(["s1", "s2"]);
    expect(bundle.exemplars.map((f) => f.id)).toEqual([a("f1"), a("f2")]);
    expect(bundle.impactRadius).toEqual([a("x"), a("y"), a("z")]);
    expect(bundle.existingMechanics).toEqual(["ai", "combat"]);
    // landingAnchor = lowest sorted anchor.
    expect(bundle.landingAnchor).toBe(a("a"));
  });

  it("DETERMINISM: two assemblies from the same input are byte-identical", () => {
    const b1 = assembleBundle(makeInputs());
    const b2 = assembleBundle(makeInputs());
    // Structural equality.
    expect(b1.bundle).toEqual(b2.bundle);
    // Byte-identical JSON serialisation.
    expect(JSON.stringify(b1.bundle)).toBe(JSON.stringify(b2.bundle));
    // Same content key.
    expect(b1.contentKey).toBe(b2.contentKey);
  });

  it("DETERMINISM: input order does not affect output", () => {
    const ordered: BundleInputs = {
      landingAnchors: [a("a"), a("b"), a("c")],
      rules: [rule("r1"), rule("r2")],
      specClauses: [clause("s1"), clause("s2")],
      exemplars: [fn("f1", "Alpha"), fn("f2", "Beta")],
      impactRadius: [a("x"), a("y"), a("z")],
      existingMechanics: ["ai", "combat"],
    };
    const shuffled = makeInputs();
    expect(JSON.stringify(assembleBundle(ordered).bundle)).toBe(
      JSON.stringify(assembleBundle(shuffled).bundle),
    );
  });

  it("content key is order-independent over landing anchors", () => {
    expect(bundleContentKey([a("a"), a("b")])).toBe(bundleContentKey([a("b"), a("a")]));
  });
});

describe("T28 orderBundleSegments", () => {
  it("orders immutable-first / mutable-last", () => {
    const { bundle } = assembleBundle(makeInputs());
    const segs = orderBundleSegments(bundle);
    const firstMutable = segs.findIndex((s) => !s.immutable);
    const lastImmutable = segs.map((s) => s.immutable).lastIndexOf(true);
    expect(lastImmutable).toBeLessThan(firstMutable);
    // landing (mutable) is last.
    expect(segs[segs.length - 1]!.kind).toBe("landing");
  });

  it("segment order is deterministic", () => {
    const { bundle } = assembleBundle(makeInputs());
    expect(JSON.stringify(orderBundleSegments(bundle))).toBe(
      JSON.stringify(orderBundleSegments(bundle)),
    );
  });
});
