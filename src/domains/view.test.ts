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

  // ── #324: bridge file-anchored spec links to function-anchored implementors ──

  it("reaches a domain via a FILE-anchored link when given an implementor→file map", () => {
    // Spec links are file-anchored (`from` = a source file path), but the
    // domain's implementors are function anchors in that file. Without the map
    // the join misses; with it the Japanese description surfaces.
    const anchorToFile = new Map<string, string>([
      ["fnA", "/repo/src/combat.cpp"],
      ["fnB", "/repo/src/combat.cpp"],
    ]);
    const views = buildDomainView(
      [domain("combat", ["fnA", "fnB"])],
      [link("/repo/src/combat.cpp", "c1", 1, "explicit")], // file-anchored
      [clause("c1", "§2 / 戦闘", "戦闘ドメインの中核。")],
      anchorToFile,
    );
    expect(views[0]!.description).toBe("§2 / 戦闘: 戦闘ドメインの中核。");
    expect(views[0]!.specRefs).toHaveLength(1);
  });

  it("still returns null for a file-anchored link when no map is supplied (legacy)", () => {
    const views = buildDomainView(
      [domain("combat", ["fnA"])],
      [link("/repo/src/combat.cpp", "c1", 1, "explicit")],
      [clause("c1", "§2 / 戦闘", "戦闘ドメインの中核。")],
      // no anchorToFile → file-anchored link cannot reach the function anchor
    );
    expect(views[0]!.specRefs).toHaveLength(0);
    expect(views[0]!.description).toBeNull();
  });

  it("matches both anchor-level and file-level links for the same domain", () => {
    const anchorToFile = new Map<string, string>([["fnA", "/repo/src/x.cpp"]]);
    const views = buildDomainView(
      [domain("d", ["fnA"])],
      [
        link("fnA", "c-fn", 0.5), // function-anchored (e.g. a future linker)
        link("/repo/src/x.cpp", "c-file", 0.9, "explicit"), // file-anchored
      ],
      [clause("c-fn", "§fn", "関数リンク。"), clause("c-file", "§file", "ファイルリンク。")],
      anchorToFile,
    );
    const headings = views[0]!.specRefs.map((r) => r.heading).sort();
    expect(headings).toEqual(["§file", "§fn"]);
    expect(views[0]!.description).toBe("§file: ファイルリンク。"); // higher confidence
  });
});
