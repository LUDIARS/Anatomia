/**
 * Pure cache-view panel logic (src/adapters/web/public/web-views-logic.js).
 * These small shaping functions back the Scenes, Search and
 * manifest-summary panels; extracted from index.html so they are testable
 * without a browser.
 */
import { describe, it, expect } from "vitest";
import {
  formatAccess,
  scenesForFilter,
  manifestSummary,
  searchResultLabel,
} from "./web-views-logic.js";

describe("formatAccess", () => {
  it("orders kinds calls,reads,writes,… regardless of key order", () => {
    expect(formatAccess({ targetLabel: "ui", kinds: { reads: 1, calls: 3 } }))
      .toBe("→ ui (calls 3, reads 1)");
    expect(
      formatAccess({ targetLabel: "store", kinds: { writes: 2, reads: 4, calls: 1 } }),
    ).toBe("→ store (calls 1, reads 4, writes 2)");
  });
  it("drops zero / falsy counts", () => {
    expect(formatAccess({ targetLabel: "ui", kinds: { calls: 2, reads: 0 } }))
      .toBe("→ ui (calls 2)");
  });
  it("appends unknown kinds after the known ones", () => {
    expect(
      formatAccess({ targetLabel: "x", kinds: { mystery: 5, calls: 1 } }),
    ).toBe("→ x (calls 1, mystery 5)");
  });
  it("falls back to targetModuleId then '?' for the label", () => {
    expect(formatAccess({ targetModuleId: "src/ui", kinds: { calls: 1 } }))
      .toBe("→ src/ui (calls 1)");
    expect(formatAccess({ kinds: {} })).toBe("→ ?");
  });
  it("returns just the arrow + label when there are no kinds", () => {
    expect(formatAccess({ targetLabel: "ui" })).toBe("→ ui");
    expect(formatAccess(null)).toBe("→ ?");
  });
});

describe("scenesForFilter", () => {
  const payload = {
    scenes: [
      { id: "battle", label: "Battle" },
      { id: "boss", label: "Boss" },
      { id: "cross-screen-flow" },
    ],
  };
  it("returns all scenes when sceneId is null/empty", () => {
    expect(scenesForFilter(payload, null)).toEqual(payload.scenes);
    expect(scenesForFilter(payload, "")).toEqual(payload.scenes);
  });
  it("filters to the selected scene id", () => {
    expect(scenesForFilter(payload, "battle")).toEqual([{ id: "battle", label: "Battle" }]);
    expect(scenesForFilter(payload, "boss")).toEqual([{ id: "boss", label: "Boss" }]);
  });
  it("returns [] when no scene matches", () => {
    expect(scenesForFilter(payload, "nope")).toEqual([]);
  });
  it("tolerates a missing/empty payload", () => {
    expect(scenesForFilter(null, "battle")).toEqual([]);
    expect(scenesForFilter({}, null)).toEqual([]);
  });
});

describe("manifestSummary", () => {
  it("reports 未生成 when not prepared", () => {
    expect(manifestSummary({ prepared: false })).toEqual({
      prepared: false,
      stale: false,
      ready: false,
      label: "未生成",
    });
    expect(manifestSummary(null)).toEqual({
      prepared: false,
      stale: false,
      ready: false,
      label: "未生成",
    });
  });
  it("reports prepared + stale + a non-empty label", () => {
    const s = manifestSummary({
      prepared: true,
      preparedAt: "2026-06-23T01:02:03.000Z",
      stale: true,
    });
    expect(s.prepared).toBe(true);
    expect(s.stale).toBe(true);
    expect(s.ready).toBe(false);
    expect(s.label).not.toBe("未生成");
    expect(s.label.length).toBeGreaterThan(0);
  });
  it("defaults stale to false and tolerates a missing preparedAt", () => {
    const s = manifestSummary({ prepared: true });
    expect(s).toEqual({ prepared: true, stale: false, ready: true, label: "生成済" });
  });
});

describe("searchResultLabel", () => {
  it("appends file:line when present", () => {
    expect(
      searchResultLabel({ title: "loadGraph", file: "src/index.html", line: 882 }),
    ).toBe("loadGraph · src/index.html:882");
  });
  it("omits the line when absent", () => {
    expect(searchResultLabel({ title: "combat", file: "src/combat" })).toBe(
      "combat · src/combat",
    );
  });
  it("uses the title alone when there is no file", () => {
    expect(searchResultLabel({ title: "domain: combat" })).toBe("domain: combat");
  });
  it("falls back to ref then a placeholder", () => {
    expect(searchResultLabel({ ref: "anchor:1" })).toBe("anchor:1");
    expect(searchResultLabel({})).toBe("(untitled)");
    expect(searchResultLabel(null)).toBe("(untitled)");
  });
});
