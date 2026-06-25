/**
 * Pure Domain-View panel logic (src/adapters/web/public/domain-view-logic.js).
 * These functions used to live inline in index.html's renderAccess/focusDomain,
 * untestable. Extracted so the folding algorithm is regression-protected without
 * a browser. (The per-domain aggregation moved server-side — its tests are in
 * src/domains/__tests__/view-graph.test.ts.)
 */
import { describe, it, expect } from "vitest";
import {
  unitOfFile,
  accessRowsFor,
  foldUnitGraph,
} from "../public/domain-view-logic.js";

describe("unitOfFile", () => {
  it("uses the directory as the feature unit", () => {
    expect(unitOfFile("src/combat/weapon.cpp")).toBe("src/combat");
    expect(unitOfFile("a/b/c/x.cs")).toBe("a/b/c");
  });
  it("strips a known extension when there is no directory", () => {
    expect(unitOfFile("main.cpp")).toBe("main");
    expect(unitOfFile("hud.tsx")).toBe("hud");
  });
});

describe("accessRowsFor", () => {
  const patterns = [
    { name: "GameManager", kind: "singleton", file: "g/GM.cs", accessors: [
      { domain: "combat", access: "reads" }, { domain: "ui", access: "reads" },
    ] },
    { name: "RankClient", kind: "network", target: "ランキングサーバ", file: "n/R.cs", accessors: [
      { domain: "combat", access: "calls" }, { domain: "combat", access: "reads" },
    ] },
    { name: "UiFacade", kind: "facade", file: "u/UF.cs", accessors: [
      { domain: "ui", access: "calls" },
    ] },
  ];

  it("returns only patterns the domain touches, collapsing access kinds", () => {
    const rows = accessRowsFor(patterns, "combat");
    // sorted by (kind, name): "network" < "singleton".
    expect(rows.map((r) => r.name)).toEqual(["RankClient", "GameManager"]);
    const rank = rows.find((r) => r.name === "RankClient")!;
    expect(rank.how).toBe("calls/reads"); // both kinds, deduped
    expect(rank.target).toBe("ランキングサーバ");
  });

  it("sorts by (kind, name)", () => {
    const rows = accessRowsFor(patterns, "ui");
    expect(rows.map((r) => `${r.kind}:${r.name}`)).toEqual(["facade:UiFacade", "singleton:GameManager"]);
  });

  it("returns [] when no pattern touches the domain (and tolerates null input)", () => {
    expect(accessRowsFor(patterns, "audio")).toEqual([]);
    expect(accessRowsFor(null, "combat")).toEqual([]);
  });
});

describe("foldUnitGraph", () => {
  it("folds cross-cutting hubs when fold is on", () => {
    // 'hub' links to 7 distinct modules → degree 7 ≥ HUB_DEGREE(=max(6,ceil(8*0.6))=6).
    const units = ["hub", "m1", "m2", "m3", "m4", "m5", "m6", "m7"];
    const pairs = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"].map((m) => ({ from: "hub", to: m, w: 1 }));
    const agg = { units, unit: {}, pairs, totalUnits: 8, totalFns: 8 };

    const folded = foldUnitGraph(agg, { fold: true });
    expect(folded.hub["hub"]).toBe(1);
    expect(folded.foldedHubs).toBe(1);
    expect(folded.visiblePairs).toHaveLength(0); // every edge touched the hub

    // With fold off, nothing is folded.
    const open = foldUnitGraph(agg, { fold: false });
    expect(open.foldedHubs).toBe(0);
    expect(open.visiblePairs).toHaveLength(7);
  });

  it("folds weak (weight-1) links only when the graph is dense and fold is on", () => {
    // 3 units, 4 pairs (> units) → dense. weight-1 links drop when folding.
    const agg = {
      units: ["A", "B", "C"],
      unit: {},
      pairs: [
        { from: "A", to: "B", w: 2 },
        { from: "B", to: "C", w: 1 },
        { from: "C", to: "A", w: 1 },
        { from: "B", to: "A", w: 1 },
      ],
      totalUnits: 3,
      totalFns: 3,
    };
    const dense = foldUnitGraph(agg, { fold: true });
    // only the w≥2 link survives the weak-edge fold
    expect(dense.visiblePairs).toEqual([{ from: "A", to: "B", w: 2 }]);
    expect(dense.foldedEdges).toBe(3);
  });

  it("reports per-group degree from the precomputed pairs", () => {
    const agg = {
      units: ["A", "B", "C"],
      unit: {},
      pairs: [{ from: "A", to: "B", w: 1 }, { from: "A", to: "C", w: 1 }],
      totalUnits: 3,
      totalFns: 3,
    };
    const r = foldUnitGraph(agg, { fold: false });
    expect(r.degreeByGroup).toEqual({ A: 2, B: 1, C: 1 });
    expect(r.visiblePairs).toHaveLength(2);
  });
});
