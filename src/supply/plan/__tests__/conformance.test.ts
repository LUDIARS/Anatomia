import { describe, expect, it } from "vitest";
import { evaluatePlanConformance, matchesPlannedPath } from "../conformance.js";
import { planConformanceGate } from "../../gates/plan_conformance.js";
import { PLAN_VERSION, type Plan, type PlanItem } from "../types.js";

function item(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    id: "pictor/kirie-transform",
    dependsOn: [],
    uxCritical: false,
    repo: "pictor",
    domain: "kirie-transform",
    status: "existing",
    responsibility: "変換",
    plannedPaths: ["src/kirie/layers.cpp"],
    ownedPathPatterns: ["(^|/)src/kirie/[^/]+$"],
    neededTypes: [],
    layer: "src",
    dataDefs: [],
    duplicates: [],
    exemplar: null,
    ...overrides,
  };
}

function plan(items: PlanItem[]): Plan {
  return {
    version: PLAN_VERSION,
    task: "切り絵のデモを実装する",
    taskHash: "abc123",
    generatedAt: "2026-09-05T00:00:00.000Z",
    repos: ["pictor"],
    source: "llm",
    items,
    unresolved: [],
    questions: [],
    notes: [],
    layerWarnings: [],
  };
}

describe("matchesPlannedPath", () => {
  it("matches a file, a directory prefix and a glob", () => {
    expect(matchesPlannedPath("src/kirie/layers.cpp", "src/kirie/layers.cpp")).toBe(true);
    expect(matchesPlannedPath("samples/kirie", "samples/kirie/demo.cpp")).toBe(true);
    expect(matchesPlannedPath("samples/kirie/**", "samples/kirie/scene/demo.cpp")).toBe(true);
    expect(matchesPlannedPath("samples/*.cpp", "samples/demo.cpp")).toBe(true);
    expect(matchesPlannedPath("samples/*.cpp", "samples/nested/demo.cpp")).toBe(false);
  });
});

describe("evaluatePlanConformance", () => {
  it("passes when every changed file is planned or inside the domain's membership", () => {
    const result = evaluatePlanConformance(plan([item()]), [
      "src/kirie/layers.cpp",
      "src/kirie/palette.cpp",
    ]);
    expect(result.pass).toBe(true);
    expect(result.offPlan).toEqual([]);
  });

  it("reports a file outside every planned path and membership", () => {
    const result = evaluatePlanConformance(plan([item()]), ["src/billing/invoice.cpp"]);
    expect(result.pass).toBe(false);
    expect(result.offPlan).toEqual(["src/billing/invoice.cpp"]);
  });

  it("wants a new domain's declaration in the same diff", () => {
    const newItem = item({
      status: "new",
      domain: "kirie-demo",
      plannedPaths: ["samples/kirie/**"],
      ownedPathPatterns: [],
    });
    const without = evaluatePlanConformance(plan([newItem]), ["samples/kirie/demo.cpp"]);
    expect(without.undeclaredNewDomains).toEqual(["kirie-demo"]);

    const with_ = evaluatePlanConformance(plan([newItem]), [
      "samples/kirie/demo.cpp",
      "spec/domains/kirie-demo.domain.json",
    ]);
    expect(with_.undeclaredNewDomains).toEqual([]);
    expect(with_.pass).toBe(true);
  });

  it("requires the exact canonical declaration for each new domain", () => {
    const wanted = item({ status: "new", domain: "wanted", plannedPaths: ["src/wanted.cpp"] });
    const second = item({ status: "new", domain: "second", plannedPaths: ["src/second.cpp"] });
    const result = evaluatePlanConformance(plan([wanted, second]), [
      "src/wanted.cpp",
      "src/second.cpp",
      "spec/domains/unrelated.json",
      "spec/domains/wanted.domain.json",
    ]);
    expect(result.undeclaredNewDomains).toEqual(["second"]);
    expect(result.offPlan).toContain("spec/domains/unrelated.json");
    expect(result.onPlan).toContain("spec/domains/wanted.domain.json");
  });

  it("only considers the requested repo's items in a cross-repo plan", () => {
    const cross = plan([item(), item({ repo: "figmentum", plannedPaths: ["src/other.cpp"], ownedPathPatterns: [] })]);
    cross.repos.push("figmentum");
    const result = evaluatePlanConformance(cross, ["src/other.cpp"], { repo: "pictor" });
    expect(result.offPlan).toEqual(["src/other.cpp"]);
  });

  it("rejects an ambiguous cross-repo comparison with no repo identity", () => {
    const cross = plan([item(), item({ repo: "figmentum" })]);
    cross.repos.push("figmentum");
    expect(() => evaluatePlanConformance(cross, ["src/kirie/layers.cpp"])).toThrow(
      /repo is required/,
    );
  });
});

describe("planConformanceGate", () => {
  it("names the off-plan file and what to do about it", () => {
    const gate = planConformanceGate(plan([item()]), ["src/billing/invoice.cpp"]);
    expect(gate.gate).toBe("plan_conformance");
    expect(gate.pass).toBe(false);
    expect(gate.suggestion).toMatch(/計画外: src\/billing\/invoice\.cpp/);
    expect(gate.suggestion).toMatch(/membership/);
  });

  it("passes silently when the diff stayed inside the plan", () => {
    const gate = planConformanceGate(plan([item()]), ["src/kirie/layers.cpp"]);
    expect(gate.pass).toBe(true);
    expect(gate.suggestion).toBeNull();
  });
});
