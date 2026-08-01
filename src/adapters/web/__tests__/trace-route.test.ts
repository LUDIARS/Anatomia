import { describe, expect, it } from "vitest";
import { buildFromSource } from "../../../supply/__tests__/helpers.js";
import { RecordedTraceSource } from "../../../dynamic/viz/trace-source.js";
import type { AnalysisContext } from "../../../core.js";
import { createApp } from "../server.js";

describe("GET /api/trace/where", () => {
  it("resolves the active anchor against the resolved project context", async () => {
    const { graph, file, functions } = await buildFromSource("void updatePlayer() {}\n");
    const anchor = functions[0]?.id;
    if (anchor == null) throw new Error("fixture function must have an anchor");

    const ctx: AnalysisContext = {
      repoPath: "/fixture",
      graph,
      files: [file],
      functions,
      domains: [{
        domain: "player-actions",
        implementors: [anchor],
        violations: [],
        conforms: true,
      }],
      links: [],
      specClauses: [],
    };
    const trace = new RecordedTraceSource([{
      stitched: {
        frameId: 7,
        frameBeginUs: 100,
        frameEndUs: 200,
        activeDomains: [],
        hotZone: null,
        domainTimes: {},
      },
      activeZoneSet: [anchor],
    }]);
    const app = createApp(ctx, trace);

    const response = await app.fetch(new Request("http://localhost/api/trace/where?project=fixture"));
    expect(response.status).toBe(200);
    const body = await response.json() as {
      domain: string | null;
      functionAnchorId: string | null;
      label: string;
    };
    expect(body.domain).toBe("player-actions");
    expect(body.functionAnchorId).toBe(anchor);
    expect(body.label).toContain("domain=player-actions");
  });
});
