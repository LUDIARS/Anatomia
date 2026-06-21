/**
 * Pure Domain-View panel logic (src/adapters/web/public/domain-view-logic.js).
 * These functions used to live inline in index.html's renderAccess/focusDomain,
 * untestable. Extracted so the aggregation + folding algorithm is regression-
 * protected without a browser.
 */
import { describe, it, expect } from "vitest";
import {
  unitOfFile,
  accessRowsFor,
  buildDomainUnitGraph,
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

describe("buildDomainUnitGraph", () => {
  const node = (id: string, group: string, name = id) => ({
    id, group, color: { background: "#123" }, label: name, _meta: { name },
  });

  it("collapses implementors into feature units with counts and colours", () => {
    const nodes = [node("a1", "combat"), node("a2", "combat"), node("a3", "ui"), node("z", "other")];
    const g = buildDomainUnitGraph(["a1", "a2", "a3"], nodes, [], { fold: false, maxUnits: 60 });
    expect(g.unit["combat"].count).toBe(2);
    expect(g.unit["ui"].count).toBe(1);
    expect(g.unit["other"]).toBeUndefined(); // z is not an implementor
    expect(g.unit["combat"].color).toBe("#123");
    expect(g.totalFns).toBe(3);
    expect(g.totalUnits).toBe(2);
  });

  it("aggregates cross-module edges into weighted module pairs", () => {
    const nodes = [node("a1", "combat"), node("a2", "combat"), node("b1", "ui")];
    const edges = [
      { from: "a1", to: "b1" }, { from: "a2", to: "b1" }, // combat→ui twice
      { from: "a1", to: "a2" },                            // same module → ignored
    ];
    const g = buildDomainUnitGraph(["a1", "a2", "b1"], nodes, edges, { fold: false, maxUnits: 60 });
    expect(g.pairs).toEqual([{ from: "combat", to: "ui", w: 2 }]);
    expect(g.visiblePairs).toEqual([{ from: "combat", to: "ui", w: 2 }]);
  });

  it("truncates to the top maxUnits by function count", () => {
    const nodes = [
      node("a1", "big"), node("a2", "big"), node("a3", "big"),
      node("b1", "mid"), node("b2", "mid"),
      node("c1", "small"),
    ];
    const g = buildDomainUnitGraph(["a1", "a2", "a3", "b1", "b2", "c1"], nodes, [], { fold: false, maxUnits: 2 });
    expect(g.totalUnits).toBe(3);
    expect(g.units.sort()).toEqual(["big", "mid"]); // "small" dropped
  });

  it("folds cross-cutting hubs when fold is on", () => {
    // 'hub' links to 7 distinct modules → degree 7 ≥ HUB_DEGREE(=max(6,ceil(8*0.6))=6).
    const groups = ["hub", "m1", "m2", "m3", "m4", "m5", "m6", "m7"];
    const nodes = groups.map((grp, i) => node("n" + i, grp));
    const edges = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"].map((m, i) => ({ from: "n0", to: "n" + (i + 1) }));
    const ids = nodes.map((n) => n.id);
    const folded = buildDomainUnitGraph(ids, nodes, edges, { fold: true, maxUnits: 60 });
    expect(folded.hub["hub"]).toBe(1);
    expect(folded.foldedHubs).toBe(1);
    expect(folded.visiblePairs).toHaveLength(0); // every edge touched the hub
    // With fold off, nothing is folded.
    const open = buildDomainUnitGraph(ids, nodes, edges, { fold: false, maxUnits: 60 });
    expect(open.foldedHubs).toBe(0);
    expect(open.visiblePairs).toHaveLength(7);
  });

  it("folds weak (weight-1) links only when the graph is dense and fold is on", () => {
    // 3 modules, 4 pairs (> units) → dense. weight-1 links drop when folding.
    const nodes = [node("a", "A"), node("b", "B"), node("c", "C")];
    const edges = [
      { from: "a", to: "b" }, { from: "a", to: "b" }, // A→B w2
      { from: "b", to: "c" },                          // B→C w1
      { from: "c", to: "a" },                          // C→A w1
      { from: "b", to: "a" },                          // B→A w1
    ];
    const ids = ["a", "b", "c"];
    const dense = buildDomainUnitGraph(ids, nodes, edges, { fold: true, maxUnits: 60 });
    // only the w≥2 link survives the weak-edge fold
    expect(dense.visiblePairs).toEqual([{ from: "A", to: "B", w: 2 }]);
    expect(dense.foldedEdges).toBe(3);
  });
});
