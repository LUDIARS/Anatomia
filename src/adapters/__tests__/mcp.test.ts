/**
 * T30 — MCP adapter tests.
 *
 * Tests tool handler functions directly (no MCP transport needed).
 * Uses buildFromSource to build a fixture AnalysisContext from inline C++.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { buildFromSource } from "../../supply/__tests__/helpers.js";
import { createHandlers } from "../mcp.js";
import type { AnalysisContext } from "../../core.js";
import { InMemoryCodeGraph } from "../../graph/in-memory.js";
import { buildGraph, extractEdgeInfo } from "../../graph/build.js";

const CPP_FIXTURE = `
void foo() { }
void bar() { foo(); }
void baz() { bar(); foo(); }
`;

let ctx: AnalysisContext;

beforeAll(async () => {
  const { graph, file, functions } = await buildFromSource(CPP_FIXTURE);
  ctx = {
    repoPath: "/fixture",
    graph,
    files: [file],
    functions,
    domains: [
      {
        domain: "jump-domain",
        implementors: [functions.find((f) => f.name === "foo")!.id!],
        violations: [],
        conforms: true,
      },
      {
        domain: "movement",
        implementors: [functions.find((f) => f.name === "bar")!.id!],
        violations: [],
        conforms: true,
      },
    ],
    specClauses: [
      {
        id: "combat-1",
        sourceFile: "spec/Game.md",
        heading: "Combat / Damage",
        text: "Damage is dealt on hit.",
        embedding: null,
      },
      {
        id: "movement-1",
        sourceFile: "spec/Game.md",
        heading: "Movement / Speed",
        text: "Actors move at speed.",
        embedding: null,
      },
    ],
  };
});

describe("anatomia.find/callers/callees", () => {
  it("finds symbols", async () => {
    const handlers = createHandlers(ctx);
    const result = await handlers["anatomia.find"]({ name: "foo" });
    expect(result.hits[0]!.name).toBe("foo");
  });

  it("lists callers and callees", async () => {
    const handlers = createHandlers(ctx);
    const callers = await handlers["anatomia.callers"]({ symbol: "foo" });
    expect(callers.hits.map((h) => h.name)).toEqual(["bar", "baz"]);

    const callees = await handlers["anatomia.callees"]({ symbol: "baz" });
    expect(callees.hits.map((h) => h.name).sort()).toEqual(["bar", "foo"]);
  });
});

describe("anatomia.context", () => {
  it("returns a ContextBundle shaped object", async () => {
    const handlers = createHandlers(ctx);
    const result = await handlers["anatomia.context"]({ task: "add a dodge skill" });
    expect(result).toHaveProperty("landingAnchor");
    expect(result).toHaveProperty("applicableRules");
    expect(result).toHaveProperty("specClauses");
    expect(result).toHaveProperty("exemplars");
    expect(result).toHaveProperty("impactRadius");
    expect(result).toHaveProperty("existingDomains");
    expect(Array.isArray(result.applicableRules)).toBe(true);
    expect(Array.isArray(result.specClauses)).toBe(true);
    expect(Array.isArray(result.exemplars)).toBe(true);
  });

  it("exemplars are functions from the context (up to 5)", async () => {
    const handlers = createHandlers(ctx);
    const result = await handlers["anatomia.context"]({ task: "refactor movement" });
    expect(result.exemplars.length).toBeLessThanOrEqual(5);
  });
});

describe("anatomia.verify", () => {
  it("returns a Verdict with pass + gates array", async () => {
    const handlers = createHandlers(ctx);
    const result = await handlers["anatomia.verify"]({ diff: "void x() { }" });
    expect(result).toHaveProperty("pass");
    expect(typeof result.pass).toBe("boolean");
    expect(Array.isArray(result.gates)).toBe(true);
    expect(result.gates.length).toBe(5);
  });

  it("clean diff passes all block gates", async () => {
    const handlers = createHandlers(ctx);
    const result = await handlers["anatomia.verify"]({ diff: "void clean() { }" });
    expect(result.pass).toBe(true);
  });

  it("gates include the 5 expected gate names", async () => {
    const handlers = createHandlers(ctx);
    const result = await handlers["anatomia.verify"]({ diff: "void y() { }" });
    const names = result.gates.map((g) => g.gate);
    expect(names).toContain("rule_conformance");
    expect(names).toContain("duplication");
    expect(names).toContain("spec_linkage");
    expect(names).toContain("coupling_delta");
    expect(names).toContain("convention_drift");
  });
});

describe("anatomia.where", () => {
  it("returns landings array", async () => {
    const handlers = createHandlers(ctx);
    const result = await handlers["anatomia.where"]({ task: "add a jump domain" });
    expect(result).toHaveProperty("landings");
    expect(Array.isArray(result.landings)).toBe(true);
    expect(result.landings.length).toBeGreaterThan(0);
  });

  it("each landing has required fields", async () => {
    const handlers = createHandlers(ctx);
    const { landings } = await handlers["anatomia.where"]({ task: "movement" });
    for (const l of landings) {
      expect(l).toHaveProperty("domain");
      expect(l).toHaveProperty("anchor");
      expect(l).toHaveProperty("layer");
      expect(l).toHaveProperty("confidence");
    }
  });
});

describe("anatomia.impact", () => {
  it("returns anchors array for a known anchor", async () => {
    const handlers = createHandlers(ctx);
    // Get a real anchor from the fixture.
    const nodes = await ctx.graph.allNodes();
    const anchor = nodes[0]?.id ?? "nonexistent";
    const result = await handlers["anatomia.impact"]({ anchor });
    expect(result).toHaveProperty("anchors");
    expect(Array.isArray(result.anchors)).toBe(true);
  });

  it("returns empty array for unknown anchor", async () => {
    const handlers = createHandlers(ctx);
    const result = await handlers["anatomia.impact"]({ anchor: "0000000000000000" });
    expect(result.anchors).toEqual([]);
  });
});

describe("anatomia.domains.suggest", () => {
  it("returns spec-seeded domain drafts", async () => {
    const handlers = createHandlers(ctx);
    const result = await handlers["anatomia.domains.suggest"]({ noLlm: true });
    expect(result.drafts.map((d) => d.name).sort()).toEqual(["Combat", "Movement"]);
  });

  it("filters suggestions by name", async () => {
    const handlers = createHandlers(ctx);
    const result = await handlers["anatomia.domains.suggest"]({ noLlm: true, only: ["Combat"] });
    expect(result.drafts.map((d) => d.name)).toEqual(["Combat"]);
  });
});
