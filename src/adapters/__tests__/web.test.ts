/**
 * T32 — Web viz adapter tests.
 *
 * Tests Hono app routes using app.fetch with a fake Request.
 * No real HTTP server is started.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { buildFromSource } from "../../supply/__tests__/helpers.js";
import { createApp } from "../web/server.js";
import type { AnalysisContext } from "../../core.js";
import type { Hono } from "hono";

const CPP_FIXTURE = `
void alpha() { }
void beta()  { alpha(); }
void gamma() { beta(); alpha(); }
`;

let app: Hono;

beforeAll(async () => {
  const { graph, file, functions } = await buildFromSource(CPP_FIXTURE);
  const ctx: AnalysisContext = {
    repoPath: "/fixture",
    graph,
    files: [file],
    functions,
  };
  app = createApp(ctx);
});

describe("GET /api/graph", () => {
  it("returns { nodes, edges } arrays", async () => {
    const res = await app.fetch(new Request("http://localhost/api/graph"));
    expect(res.status).toBe(200);
    const body = await res.json() as { nodes: unknown[]; edges: unknown[] };
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
  });

  it("nodes have expected shape", async () => {
    const res = await app.fetch(new Request("http://localhost/api/graph"));
    const body = await res.json() as { nodes: Array<{ id: string; name: string; kind: string }> };
    expect(body.nodes.length).toBeGreaterThan(0);
    const node = body.nodes[0];
    expect(node).toHaveProperty("id");
    expect(node).toHaveProperty("name");
    expect(node).toHaveProperty("kind");
  });

  it("edges have from/to/kind", async () => {
    const res = await app.fetch(new Request("http://localhost/api/graph"));
    const body = await res.json() as { edges: Array<{ from: string; to: string; kind: string }> };
    // There may be 0 edges in a minimal fixture but the field must exist.
    expect(Array.isArray(body.edges)).toBe(true);
    if (body.edges.length > 0) {
      const e = body.edges[0];
      expect(e).toHaveProperty("from");
      expect(e).toHaveProperty("to");
      expect(e).toHaveProperty("kind");
    }
  });
});

describe("GET /api/metrics", () => {
  it("returns an array of NodeMetrics", async () => {
    const res = await app.fetch(new Request("http://localhost/api/metrics"));
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ anchor: string; fanIn: number; fanOut: number }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  it("each metric has expected numeric fields", async () => {
    const res = await app.fetch(new Request("http://localhost/api/metrics"));
    const body = await res.json() as Array<Record<string, unknown>>;
    const m = body[0];
    expect(m).toHaveProperty("anchor");
    expect(m).toHaveProperty("fanIn");
    expect(m).toHaveProperty("fanOut");
    expect(m).toHaveProperty("coupling");
    expect(m).toHaveProperty("cyclomatic");
  });
});

describe("GET /api/domains", () => {
  it("returns { domains, cards }", async () => {
    const res = await app.fetch(new Request("http://localhost/api/domains"));
    expect(res.status).toBe(200);
    const body = await res.json() as { domains: unknown[]; cards: unknown[] };
    expect(Array.isArray(body.domains)).toBe(true);
    expect(Array.isArray(body.cards)).toBe(true);
  });
});

describe("GET /", () => {
  it("returns HTML page", async () => {
    const res = await app.fetch(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toContain("html");
  });
});
