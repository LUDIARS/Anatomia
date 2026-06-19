/**
 * buildDomainView — domain-view assembly over (domains × links × specClauses).
 */
import { describe, it, expect } from "vitest";
import { buildDomainView } from "./view.js";
import type { DetectionResult } from "./detect.js";
import type { AnchorId, Link, SpecClause } from "../types.js";

const clause = (id: string, heading: string, text: string, file = "spec/feature/x.md"): SpecClause => ({
  id,
  sourceFile: file,
  heading,
  text,
  embedding: null,
});

const link = (from: string, to: string, confidence: number, evidence: Link["evidence"] = "structural"): Link => ({
  from: from as unknown as AnchorId,
  to,
  confidence,
  evidence,
});

const domain = (name: string, implementors: string[], conforms = true, violations = 0): DetectionResult => ({
  domain: name,
  implementors: implementors as unknown as AnchorId[],
  violations: Array.from({ length: violations }, () => ({
    ruleId: `${name}/r`,
    severity: "error" as const,
    evidence: "v",
    anchors: [],
  })),
  conforms,
});

describe("buildDomainView", () => {
  it("skips domains with no implementors and sorts by implementor count", () => {
    const views = buildDomainView(
      [domain("empty", []), domain("small", ["a"]), domain("big", ["a", "b", "c"])],
      [],
      [],
    );
    expect(views.map((v) => v.domain)).toEqual(["big", "small"]);
  });

  it("interpolates a Japanese description from the highest-confidence linked clause", () => {
    const views = buildDomainView(
      [domain("combat", ["fnA", "fnB"])],
      [
        link("fnA", "c-low", 0.4),
        link("fnB", "c-high", 0.9),
      ],
      [
        clause("c-low", "§3 / 補助", "弱いリンクの節。"),
        clause("c-high", "§2 / 戦闘", "戦闘ドメインの中核を説明する節。"),
      ],
    );
    expect(views).toHaveLength(1);
    const v = views[0]!;
    expect(v.description).toBe("§2 / 戦闘: 戦闘ドメインの中核を説明する節。");
    // Highest confidence first.
    expect(v.specRefs[0]!.heading).toBe("§2 / 戦闘");
    expect(v.specRefs[0]!.confidence).toBe(0.9);
    expect(v.specRefs).toHaveLength(2);
  });

  it("keeps the strongest link per clause (no duplicate clause refs)", () => {
    const views = buildDomainView(
      [domain("d", ["fnA", "fnB"])],
      [
        link("fnA", "c1", 0.3),
        link("fnB", "c1", 0.8), // same clause, stronger
      ],
      [clause("c1", "§1", "節。")],
    );
    expect(views[0]!.specRefs).toHaveLength(1);
    expect(views[0]!.specRefs[0]!.confidence).toBe(0.8);
  });

  it("ignores links whose source is not an implementor of the domain", () => {
    const views = buildDomainView(
      [domain("d", ["fnA"])],
      [link("fnOther", "c1", 0.9)],
      [clause("c1", "§1", "節。")],
    );
    expect(views[0]!.specRefs).toHaveLength(0);
    expect(views[0]!.description).toBeNull();
  });

  it("truncates long clause excerpts with an ellipsis", () => {
    const long = "あ".repeat(400);
    const views = buildDomainView(
      [domain("d", ["fnA"])],
      [link("fnA", "c1", 0.5)],
      [clause("c1", "§1", long)],
    );
    const ex = views[0]!.specRefs[0]!.excerpt;
    expect(ex.endsWith("…")).toBe(true);
    expect(ex.length).toBeLessThanOrEqual(241);
  });

  it("carries conformance + violation counts and implementor anchors", () => {
    const views = buildDomainView([domain("d", ["a", "b"], false, 2)], [], []);
    expect(views[0]!.conforms).toBe(false);
    expect(views[0]!.violationCount).toBe(2);
    expect(views[0]!.implementors).toEqual(["a", "b"]);
    expect(views[0]!.implementorCount).toBe(2);
  });
});
