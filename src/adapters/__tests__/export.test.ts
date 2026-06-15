/**
 * Tests for exportGraphHtml (T50) — static interactive HTML graph export.
 *
 * Verifies that the returned string is a valid HTML document containing:
 *   - the vis-network CDN script tag
 *   - inlined node JSON (at least one node id from the fixture graph)
 *   - inlined edge JSON
 *   - a legend section
 *   - summary counts
 *
 * Does NOT test browser rendering (SRP boundary).
 */

import { describe, it, expect } from "vitest";
import { exportGraphHtml } from "../web/export.js";
import { buildFromSource } from "../../supply/__tests__/helpers.js";
import type { AnalysisContext } from "../../core.js";

const CPP_FIXTURE = `
void alpha() { }
void beta()  { alpha(); }
void gamma() { beta(); alpha(); }
`;

async function makeCtx(): Promise<AnalysisContext> {
  const { graph, file, functions } = await buildFromSource(CPP_FIXTURE);
  return {
    repoPath: "/fixture",
    graph,
    files: [file],
    functions,
    domains: [],
    specClauses: [],
    links: [],
    skipped: [],
  };
}

describe("exportGraphHtml", () => {
  it("returns a string that starts with <!DOCTYPE html>", async () => {
    const ctx = await makeCtx();
    const html = await exportGraphHtml(ctx);
    expect(html.trimStart()).toMatch(/^<!DOCTYPE html>/i);
  });

  it("includes the vis-network CDN script tag", async () => {
    const ctx = await makeCtx();
    const html = await exportGraphHtml(ctx);
    expect(html).toContain("vis-network");
    expect(html).toContain("unpkg.com");
  });

  it("inlines node JSON containing at least one node id", async () => {
    const ctx = await makeCtx();
    const nodes = await ctx.graph.allNodes();
    const html = await exportGraphHtml(ctx);
    // Each node id should appear in the inlined JSON
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) {
      expect(html).toContain(n.id);
    }
  });

  it("inlines edge JSON when edges exist", async () => {
    const ctx = await makeCtx();
    const nodes = await ctx.graph.allNodes();
    let hasEdge = false;
    for (const n of nodes) {
      const edges = await ctx.graph.edgesFrom(n.id);
      if (edges.length > 0) { hasEdge = true; break; }
    }
    if (!hasEdge) return; // fixture has no edges — skip edge assertion

    const html = await exportGraphHtml(ctx);
    // Edge data is in the inlined DATA object
    expect(html).toContain('"from"');
    expect(html).toContain('"to"');
  });

  it("contains a legend section", async () => {
    const ctx = await makeCtx();
    const html = await exportGraphHtml(ctx);
    expect(html).toContain("Legend");
    expect(html).toContain("coupling");
  });

  it("contains summary counts in the HTML", async () => {
    const ctx = await makeCtx();
    const html = await exportGraphHtml(ctx);
    // The summary counts are embedded in the DATA JSON as nodeCount/edgeCount
    expect(html).toContain('"nodeCount"');
    expect(html).toContain('"fileCount"');
    expect(html).toContain('"funcCount"');
  });

  it("respects the title option", async () => {
    const ctx = await makeCtx();
    const html = await exportGraphHtml(ctx, { title: "MyProject" });
    expect(html).toContain("MyProject");
  });

  it("contains vis-network DataSet and Network initialization", async () => {
    const ctx = await makeCtx();
    const html = await exportGraphHtml(ctx);
    expect(html).toContain("vis.DataSet");
    expect(html).toContain("vis.Network");
  });
});
