/**
 * Per-domain feature-unit aggregation (src/domains/view-graph.ts).
 *
 * This is the server-side precompute that replaced the browser's on-the-fly
 * aggregation: the panel no longer downloads the full function graph to fold it
 * per click. These tests pin the fold-independent half (the fold itself is
 * tested in the browser logic — domain-view-logic.test.ts).
 */
import { describe, it, expect } from "vitest";
import { aggregateDomainUnits, type UnitGraphNode } from "../view-graph.js";

const node = (id: string, group: string, name = id): UnitGraphNode => ({
  id,
  group,
  color: { background: "#123" },
  label: name,
  _meta: { name },
});

describe("aggregateDomainUnits", () => {
  it("collapses implementors into feature units with counts and colours", () => {
    const nodes = [node("a1", "combat"), node("a2", "combat"), node("a3", "ui"), node("z", "other")];
    const g = aggregateDomainUnits(["a1", "a2", "a3"], nodes, [], { maxUnits: 60 });
    expect(g.unit["combat"]!.count).toBe(2);
    expect(g.unit["ui"]!.count).toBe(1);
    expect(g.unit["other"]).toBeUndefined(); // z is not an implementor
    expect(g.unit["combat"]!.color).toBe("#123");
    expect(g.totalFns).toBe(3);
    expect(g.totalUnits).toBe(2);
  });

  it("keeps ≤12 representative names per unit, preferring _meta.name", () => {
    const nodes = Array.from({ length: 15 }, (_, i) => node("n" + i, "big", "fn" + i));
    const g = aggregateDomainUnits(nodes.map((n) => n.id), nodes, [], { maxUnits: 60 });
    expect(g.unit["big"]!.count).toBe(15);
    expect(g.unit["big"]!.fns).toHaveLength(12);
    expect(g.unit["big"]!.fns[0]).toBe("fn0");
  });

  it("aggregates cross-module edges into weighted module pairs (cross-module only)", () => {
    const nodes = [node("a1", "combat"), node("a2", "combat"), node("b1", "ui")];
    const edges = [
      { from: "a1", to: "b1" }, { from: "a2", to: "b1" }, // combat→ui twice
      { from: "a1", to: "a2" },                            // same module → ignored
    ];
    const g = aggregateDomainUnits(["a1", "a2", "b1"], nodes, edges, { maxUnits: 60 });
    expect(g.pairs).toEqual([{ from: "combat", to: "ui", w: 2 }]);
  });

  it("truncates to the top maxUnits by function count and drops their edges", () => {
    const nodes = [
      node("a1", "big"), node("a2", "big"), node("a3", "big"),
      node("b1", "mid"), node("b2", "mid"),
      node("c1", "small"),
    ];
    const edges = [{ from: "a1", to: "c1" }]; // big→small, but small is truncated out
    const g = aggregateDomainUnits(
      ["a1", "a2", "a3", "b1", "b2", "c1"], nodes, edges, { maxUnits: 2 },
    );
    expect(g.totalUnits).toBe(3);
    expect(g.units.sort()).toEqual(["big", "mid"]); // "small" dropped
    expect(g.unit["small"]).toBeUndefined();        // metadata pruned to rendered units
    expect(g.pairs).toEqual([]);                     // edge to the dropped unit removed
  });

  it("falls back to 'unknown' group and tolerates missing colour/meta", () => {
    const bare: UnitGraphNode = { id: "x1" };
    const g = aggregateDomainUnits(["x1"], [bare], [], { maxUnits: 60 });
    expect(g.unit["unknown"]!.count).toBe(1);
    expect(g.unit["unknown"]!.color).toBeNull();
    expect(g.unit["unknown"]!.fns).toEqual(["x1"]);
  });
});
