/**
 * Warm harness routes — POST /api/verify and GET /api/context against a
 * single-context app, exercised via app.fetch() (no live server).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { buildFromSource } from "../../supply/__tests__/helpers.js";
import { createApp } from "../web/server.js";
import type { AnalysisContext } from "../../core.js";
import type { Hono } from "hono";

let app: Hono;

beforeAll(async () => {
  const { graph, file, functions } = await buildFromSource(
    "void alpha(){} void beta(){ alpha(); }",
  );
  const ctx: AnalysisContext = {
    repoPath: "/fixture",
    graph,
    files: [file],
    functions,
    domains: [],
    links: [],
    specClauses: [],
  };
  app = createApp(ctx);
});

describe("POST /api/verify", () => {
  it("returns a Verdict for a valid diff", async () => {
    const res = await app.fetch(
      new Request("http://x/api/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ diff: "void gamma(){ alpha(); }", project: "fixture" }),
      }),
    );
    expect(res.status).toBe(200);
    const verdict = await res.json();
    expect(typeof verdict.pass).toBe("boolean");
    expect(Array.isArray(verdict.gates)).toBe(true);
  });

  it("400s on a missing diff", async () => {
    const res = await app.fetch(
      new Request("http://x/api/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: "fixture" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/context", () => {
  it("returns a ContextBundle with the expected shape", async () => {
    const res = await app.fetch(new Request("http://x/api/context?project=fixture&task=add%20a%20helper"));
    expect(res.status).toBe(200);
    const bundle = await res.json();
    expect(bundle).toHaveProperty("existingDomains");
    expect(bundle).toHaveProperty("applicableRules");
    expect(bundle).toHaveProperty("exemplars");
  });
});
