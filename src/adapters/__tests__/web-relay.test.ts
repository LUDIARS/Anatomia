/**
 * Praeforma(Thaleia) relay route — POST /relay/anatomia against a single-context
 * app, exercised via app.fetch() (no live server, hermetic).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { buildFromSource } from "../../supply/__tests__/helpers.js";
import { createApp } from "../web/server.js";
import type { AnalysisContext } from "../../core.js";
import type { Hono } from "hono";

const PF_NODE_TYPES = new Set(["symbol", "file", "domain", "spec", "external"]);
const PF_RELATIONS = new Set(["calls", "depends", "implements", "related"]);

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

async function post(body: unknown): Promise<Response> {
  return app.fetch(
    new Request("http://x/relay/anatomia", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /relay/anatomia", () => {
  it("returns {nodes, edges, summary} mapped to the Praeforma contract", async () => {
    const res = await post({
      project: "default",
      target: { kind: "domain", id: "d1", name: "alpha" },
      requirements: [{ title: "alpha を呼ぶ" }],
      query: "alpha を呼ぶ処理",
    });
    expect(res.status).toBe(200);
    const out = await res.json();

    expect(Array.isArray(out.nodes)).toBe(true);
    expect(Array.isArray(out.edges)).toBe(true);
    expect(typeof out.summary).toBe("string");
    expect(out.nodes.length).toBeGreaterThan(0);

    // every node conforms to the Pf node shape + enum
    for (const n of out.nodes) {
      expect(typeof n.key).toBe("string");
      expect(typeof n.label).toBe("string");
      expect(PF_NODE_TYPES.has(n.type)).toBe(true);
      expect(typeof n.anatomia_ref.path).toBe("string");
      expect(typeof n.anatomia_ref.line).toBe("number");
    }
    // functions map to 'symbol'
    expect(out.nodes.every((n: { type: string }) => n.type === "symbol")).toBe(true);

    // edges use the Pf relation enum and reference returned node keys only
    const keys = new Set(out.nodes.map((n: { key: string }) => n.key));
    for (const e of out.edges) {
      expect(PF_RELATIONS.has(e.relation)).toBe(true);
      expect(keys.has(e.from)).toBe(true);
      expect(keys.has(e.to)).toBe(true);
    }
    // beta() calls alpha() — the calls edge should survive as relation 'calls'
    expect(out.edges.some((e: { relation: string }) => e.relation === "calls")).toBe(true);
  });

  it("400s on a missing query", async () => {
    const res = await post({ project: "default", target: { kind: "domain", id: "d1", name: "x" } });
    expect(res.status).toBe(400);
  });

  it("resolves the single context when project is omitted", async () => {
    // legacy single-context createApp resolves any/undefined project to the one
    // ctx (the 404 path only fires in ProjectManager mode for an unknown id).
    const res = await post({ query: "something" });
    expect(res.status).toBe(200);
  });
});
