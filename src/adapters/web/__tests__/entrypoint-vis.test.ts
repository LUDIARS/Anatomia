import { describe, expect, it } from "vitest";
import type { AnchorId } from "../../../types.js";
import type { EntryPointGraph } from "../../../entrypoints/types.js";
import { buildEntryPointVisData } from "../entrypoint-vis.js";

describe("buildEntryPointVisData", () => {
  it("renders unresolved calls as dashed frontier stubs", () => {
    const anchor = "entry-anchor" as AnchorId;
    const graph: EntryPointGraph = {
      schemaVersion: 1,
      projectId: "p",
      sourceRevision: "revision",
      definitionFingerprint: "fingerprint",
      entries: [{
        id: anchor,
        classes: ["process"],
        detector: ["process-main"],
        symbol: { anchor, name: "main", path: "src/main.ts", line: 1 },
        reached: 1,
        maxDistance: 0,
        activatesDomains: { business: [], program: [] },
        frontierCount: 1,
      }],
      nodes: [{
        anchor,
        name: "main",
        path: "src/main.ts",
        reachedFrom: [anchor],
        distance: { [anchor]: 0 },
        via: {},
        frontier: [{ calleeName: "external", reason: "external-type" }],
      }],
      edges: [],
      unrooted: [],
      diagnostics: [],
    };

    const view = buildEntryPointVisData(graph, "fixture");
    const frontier = view.edges.find((edge) => edge.to.includes("#frontier-"));
    expect(frontier?.dashes).toBe(true);
  });
});
