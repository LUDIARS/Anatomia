/**
 * Tests for T25 — harden.ts
 */

import { describe, it, expect } from "vitest";
import type { Link } from "../types.js";
import { ratify, mergeLinks, hardenLoop } from "./harden.js";

function makeLink(
  from: string,
  to: string,
  evidence: Link["evidence"],
  confidence: number,
): Link {
  return {
    from: from as Link["from"],
    to,
    evidence,
    confidence,
  };
}

describe("ratify", () => {
  it("promotes evidence to 'explicit' and confidence to 1.0", () => {
    const link = makeLink("src/hash.ts", "SPEC-001", "structural", 0.6);
    const result = ratify(link);
    expect(result.evidence).toBe("explicit");
    expect(result.confidence).toBe(1.0);
  });

  it("sets ratified: true", () => {
    const link = makeLink("src/hash.ts", "SPEC-001", "semantic", 0.5);
    const result = ratify(link);
    expect(result.ratified).toBe(true);
  });

  it("does not mutate the original link", () => {
    const link = makeLink("src/hash.ts", "SPEC-001", "structural", 0.6);
    ratify(link);
    expect(link.evidence).toBe("structural");
    expect(link.ratified).toBeUndefined();
  });
});

describe("mergeLinks", () => {
  it("keeps explicit over structural for the same (from, to) pair", () => {
    const structural = makeLink("a.ts", "SPEC-001", "structural", 0.7);
    const explicit = makeLink("a.ts", "SPEC-001", "explicit", 0.9);

    const result = mergeLinks([structural, explicit]);
    expect(result).toHaveLength(1);
    expect(result[0].evidence).toBe("explicit");
  });

  it("keeps structural over semantic for the same (from, to) pair", () => {
    const semantic = makeLink("b.ts", "SPEC-002", "semantic", 0.8);
    const structural = makeLink("b.ts", "SPEC-002", "structural", 0.5);

    const result = mergeLinks([semantic, structural]);
    expect(result).toHaveLength(1);
    expect(result[0].evidence).toBe("structural");
  });

  it("within same tier, keeps higher confidence", () => {
    const low = makeLink("c.ts", "SPEC-003", "semantic", 0.4);
    const high = makeLink("c.ts", "SPEC-003", "semantic", 0.9);

    const result = mergeLinks([low, high]);
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0.9);
  });

  it("keeps distinct (from, to) pairs as separate links", () => {
    const a = makeLink("a.ts", "SPEC-001", "explicit", 1.0);
    const b = makeLink("b.ts", "SPEC-001", "explicit", 1.0);
    const c = makeLink("a.ts", "SPEC-002", "explicit", 1.0);

    const result = mergeLinks([a, b, c]);
    expect(result).toHaveLength(3);
  });
});

describe("hardenLoop", () => {
  it("ratifies all links when ratifyFn always returns true", () => {
    const links = [
      makeLink("a.ts", "SPEC-001", "semantic", 0.5),
      makeLink("b.ts", "SPEC-002", "structural", 0.6),
    ];

    const result = hardenLoop(links, () => true);
    expect(result.every((l) => l.ratified === true)).toBe(true);
    expect(result.every((l) => l.evidence === "explicit")).toBe(true);
    expect(result.every((l) => l.confidence === 1.0)).toBe(true);
  });

  it("ratifies no links when ratifyFn always returns false", () => {
    const links = [
      makeLink("a.ts", "SPEC-001", "structural", 0.7),
    ];

    const result = hardenLoop(links, () => false);
    expect(result[0].ratified).toBeUndefined();
    expect(result[0].evidence).toBe("structural");
  });

  it("selectively ratifies based on ratifyFn", () => {
    const links = [
      makeLink("a.ts", "SPEC-001", "explicit", 1.0),
      makeLink("b.ts", "SPEC-002", "semantic", 0.4),
    ];

    // Only ratify semantic links
    const result = hardenLoop(links, (l) => l.evidence === "semantic");
    expect(result[0].ratified).toBeUndefined(); // explicit — not ratified by fn
    expect(result[1].ratified).toBe(true);
  });

  it("does not mutate the original links array", () => {
    const links = [makeLink("x.ts", "SPEC-001", "semantic", 0.3)];
    hardenLoop(links, () => true);
    expect(links[0].ratified).toBeUndefined();
  });
});
