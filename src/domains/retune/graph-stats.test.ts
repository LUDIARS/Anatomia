import { describe, it, expect } from "vitest";
import { nodeSize, percentile, classifyBySize, dirStats } from "./graph-stats.js";
import type { NodeSummary } from "./types.js";

function n(name: string, dir: string, size: number): NodeSummary {
  return { id: `${dir}/${name}`, name, relPath: `${dir}/${name}.ts`, dir, cyclomatic: 1, fanIn: 0, fanOut: 0, coupling: 0, size };
}

describe("retune graph-stats", () => {
  it("nodeSize sums complexity + degree", () => {
    expect(nodeSize(3, 2, 4)).toBe(9);
  });

  it("percentile is nearest-rank", () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(v, 0.7)).toBe(7);
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([42], 0.9)).toBe(42);
  });

  it("classifyBySize splits at the percentile threshold", () => {
    const nodes = [n("a", "src/x", 10), n("b", "src/x", 8), n("c", "src/y", 1), n("d", "src/y", 0)];
    const split = classifyBySize(nodes, 0.7);
    // threshold = p70 of [0,1,8,10] = 8 → large: size>=8 and >0
    expect(split.threshold).toBe(8);
    expect(split.large.map((x) => x.name).sort()).toEqual(["a", "b"]);
    expect(split.small.map((x) => x.name).sort()).toEqual(["c", "d"]);
  });

  it("dirStats aggregates by directory, heaviest first", () => {
    const nodes = [n("a", "src/x", 10), n("b", "src/x", 8), n("c", "src/y", 1)];
    const stats = dirStats(nodes);
    expect(stats[0]!.dir).toBe("src/x");
    expect(stats[0]!.nodeCount).toBe(2);
    expect(stats[0]!.totalSize).toBe(18);
    expect(stats[0]!.representatives).toEqual(["a", "b"]);
    expect(stats[1]!.dir).toBe("src/y");
  });
});
