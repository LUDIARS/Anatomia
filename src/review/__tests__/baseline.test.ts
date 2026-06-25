import { describe, it, expect } from "vitest";
import { applyBaseline, fingerprintViolation, fingerprintDup, fingerprintCycle, fingerprintCoupling } from "../baseline.js";
import type { ReviewBaseline } from "../baseline.js";
import type { ReviewReport } from "../build.js";

function makeReport(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    project: "/repo",
    summary: { violations: 2, hotspots: 0, cycles: 1, structuralDup: 1, domainCoupling: 1, orphans: 0, specGaps: 0 },
    violations: [
      { rule: "layer/spine", severity: "error", evidence: "A→B", locations: [] },
      { rule: "layer/forbidden", severity: "warning", evidence: "C→D", locations: [] },
    ],
    hotspots: [],
    cycles: [[{ anchor: "fn1" as any, name: "fn1", file: "a.ts", line: 1 }]],
    structuralDup: [{ anchor: "hash1" as any, name: "dup", copies: [] }],
    domainCoupling: [{ from: "auth", to: "ui", edges: 3 }],
    orphans: [],
    specGaps: [],
    ...overrides,
  };
}

describe("baseline fingerprinting", () => {
  it("fingerprintViolation uses rule + evidence", () => {
    const v = { rule: "r", severity: "error" as const, evidence: "e", locations: [] };
    expect(fingerprintViolation(v)).toBe("r\0e");
  });

  it("fingerprintDup uses anchor", () => {
    expect(fingerprintDup({ anchor: "h1" as any, name: "f", copies: [] })).toBe("h1");
  });

  it("fingerprintCycle joins locations", () => {
    const locs = [
      { anchor: "a" as any, name: "a", file: "x.ts", line: 1 },
      { anchor: "b" as any, name: "b", file: "y.ts", line: 5 },
    ];
    expect(fingerprintCycle(locs)).toBe("x.ts:1,y.ts:5");
  });

  it("fingerprintCoupling uses arrow notation", () => {
    expect(fingerprintCoupling({ from: "auth", to: "ui", edges: 1 })).toBe("auth→ui");
  });
});

describe("applyBaseline", () => {
  it("suppresses acknowledged violations", () => {
    const report = makeReport();
    const baseline: ReviewBaseline = {
      violations: new Set(["layer/spine\0A→B"]),
      structuralDup: new Set(),
      cycles: new Set(),
      domainCoupling: new Set(),
    };
    const filtered = applyBaseline(report, baseline);
    expect(filtered.violations).toHaveLength(1);
    expect(filtered.violations[0]!.rule).toBe("layer/forbidden");
    expect(filtered.summary.violations).toBe(1);
  });

  it("suppresses acknowledged structuralDup", () => {
    const report = makeReport();
    const baseline: ReviewBaseline = {
      violations: new Set(),
      structuralDup: new Set(["hash1"]),
      cycles: new Set(),
      domainCoupling: new Set(),
    };
    const filtered = applyBaseline(report, baseline);
    expect(filtered.structuralDup).toHaveLength(0);
    expect(filtered.summary.structuralDup).toBe(0);
  });

  it("suppresses acknowledged domainCoupling", () => {
    const report = makeReport();
    const baseline: ReviewBaseline = {
      violations: new Set(),
      structuralDup: new Set(),
      cycles: new Set(),
      domainCoupling: new Set(["auth→ui"]),
    };
    const filtered = applyBaseline(report, baseline);
    expect(filtered.domainCoupling).toHaveLength(0);
    expect(filtered.summary.domainCoupling).toBe(0);
  });

  it("passes through non-acknowledged findings unchanged", () => {
    const report = makeReport();
    const baseline: ReviewBaseline = {
      violations: new Set(),
      structuralDup: new Set(),
      cycles: new Set(),
      domainCoupling: new Set(),
    };
    const filtered = applyBaseline(report, baseline);
    expect(filtered.violations).toHaveLength(2);
    expect(filtered.structuralDup).toHaveLength(1);
    expect(filtered.domainCoupling).toHaveLength(1);
  });

  it("recalculates summary counts", () => {
    const report = makeReport();
    const baseline: ReviewBaseline = {
      violations: new Set(["layer/spine\0A→B", "layer/forbidden\0C→D"]),
      structuralDup: new Set(["hash1"]),
      cycles: new Set(),
      domainCoupling: new Set(["auth→ui"]),
    };
    const filtered = applyBaseline(report, baseline);
    expect(filtered.summary.violations).toBe(0);
    expect(filtered.summary.structuralDup).toBe(0);
    expect(filtered.summary.domainCoupling).toBe(0);
    expect(filtered.summary.hotspots).toBe(0); // unchanged
  });
});
