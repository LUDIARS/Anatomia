/**
 * Tests for integral search (the 3-layer scoped retrieval) + the path cache.
 *
 * Builds a real two-directory graph and hand-builds domains + a scene so the
 * containment climb (function → module → domain → scene → scene-adjacent) is
 * exercised deterministically, with a fake LLM for the judge so the path cache's
 * replay (no second LLM call) is observable.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { parse } from "../../dag/parser.js";
import { extractFunctions } from "../../dag/extract.js";
import { normalize } from "../../dag/normalize.js";
import { assignAnchorId } from "../../dag/hash.js";
import { buildFileNode } from "../../dag/merkle.js";
import { buildGraph, extractEdgeInfo } from "../../graph/build.js";
import { InMemoryCodeGraph } from "../../graph/in-memory.js";
import type { AnchorId, FileNode, FunctionNode } from "../../types.js";
import type { DetectionResult } from "../../domains/detect.js";
import { resolveSeeds } from "../resolve.js";
import { integralSearch } from "../search.js";
import { parseScopeDecision } from "../agent.js";
import { runIntegral } from "../run.js";
import { createIntegralCache } from "../cache.js";
import { createSceneModel } from "../scene.js";
import type { IntegralContext } from "../search.js";

const A_SRC = `
int a_helper() { return 1; }
int a_main() { return a_helper(); }
`;
const B_SRC = `
int b1() { return 1; }
int b2() { return 2; }
`;

async function makeFile(src: string, path: string): Promise<FileNode> {
  const tree = await parse(src, "cpp");
  const fns = extractFunctions(tree, src, path);
  for (const fn of fns) assignAnchorId(fn, normalize(fn.bodyAst));
  return buildFileNode(path, fns);
}

let graph: InMemoryCodeGraph;
let functions: FunctionNode[];
let idOf: Record<string, AnchorId>;
let domains: DetectionResult[];
let ctx: IntegralContext;

beforeAll(async () => {
  const a = await makeFile(A_SRC, "/proj/a/x.cpp");
  const b = await makeFile(B_SRC, "/proj/b/y.cpp");
  const edgeInfo = extractEdgeInfo([a, b]);
  graph = new InMemoryCodeGraph(buildGraph([a, b], edgeInfo));
  functions = [...a.functions, ...b.functions];
  idOf = {};
  for (const fn of functions) if (fn.id) idOf[fn.name] = fn.id;
  domains = [
    { domain: "domA", implementors: [idOf["a_helper"]!, idOf["a_main"]!], violations: [], conforms: true },
    { domain: "domB", implementors: [idOf["b1"]!, idOf["b2"]!], violations: [], conforms: true },
  ];
  ctx = { graph, domains, functions, specClauses: [], links: [], rules: [] };
});

describe("resolveSeeds", () => {
  it("resolves a function name to its anchor", async () => {
    const seeds = await resolveSeeds({ ref: "a_main", scope: "function" }, {
      graph,
      domains,
      scenes: createSceneModel([]),
    });
    expect(seeds).toEqual([idOf["a_main"]!]);
  });

  it("resolves a domain to its implementor anchors", async () => {
    const seeds = await resolveSeeds({ ref: "domA", scope: "domain" }, {
      graph,
      domains,
      scenes: createSceneModel([]),
    });
    expect(new Set(seeds)).toEqual(new Set([idOf["a_helper"]!, idOf["a_main"]!]));
  });

  it("resolves a scene to the anchors of its active domains", async () => {
    const scenes = createSceneModel([{ id: "S1", domains: ["domA", "domB"] }]);
    const seeds = await resolveSeeds({ ref: "S1", scope: "scene" }, { graph, domains, scenes });
    expect(seeds.length).toBe(4);
  });
});

describe("integralSearch — containment climb", () => {
  it("climb=function surfaces seeds + radius only, no domain layer", async () => {
    const r = await integralSearch(ctx, {
      entry: { ref: "a_main", scope: "function" },
      range: { climb: "function" },
    });
    expect(r.seeds).toEqual([idOf["a_main"]!]);
    expect(r.domains.length).toBe(0);
    // a_main's radius reaches a_helper.
    expect(r.anchors.some((a) => a.id === idOf["a_helper"]!)).toBe(true);
  });

  it("climb=module pulls the seed's whole 機能(module)", async () => {
    const r = await integralSearch(ctx, {
      entry: { ref: "a_main", scope: "function" },
      range: { climb: "module" },
    });
    const home = r.modules.find((m) => m.isHome);
    expect(home).toBeDefined();
    expect(home!.id).toBe("/proj/a");
  });

  it("climb=scene-adjacent reaches the other domain in a shared scene", async () => {
    const scenes = createSceneModel([{ id: "S1", domains: ["domA", "domB"] }]);
    const r = await integralSearch(
      ctx,
      { entry: { ref: "domA", scope: "domain" }, range: { climb: "scene-adjacent" } },
      scenes,
    );
    const names = r.domains.map((d) => d.name);
    expect(names).toContain("domA");
    expect(names).toContain("domB");
    expect(r.scenes.some((s) => s.id === "S1")).toBe(true);
  });

  it("honours maxNodes and flags truncation", async () => {
    const r = await integralSearch(ctx, {
      entry: { ref: "domA", scope: "domain" },
      range: { climb: "scene-adjacent", maxNodes: 1 },
    });
    expect(r.truncated).toBe(true);
    expect(r.stopReason).toBe("maxNodes");
    expect(r.anchors.length).toBeLessThanOrEqual(1);
  });

  it("is deterministic (same contentKey for the same query)", async () => {
    const q = { entry: { ref: "domA", scope: "domain" as const }, range: { climb: "domain" as const } };
    const r1 = await integralSearch(ctx, q);
    const r2 = await integralSearch(ctx, q);
    expect(r1.contentKey).toBe(r2.contentKey);
  });
});

describe("parseScopeDecision", () => {
  it("parses a judge JSON response and keeps only valid anchors", async () => {
    const r = await integralSearch(ctx, { entry: { ref: "domA", scope: "domain" }, range: { climb: "domain" } });
    const someAnchor = r.anchors[0]!.id;
    const decision = parseScopeDecision(
      `Sure: {"sufficientScope":"domain","keepAnchors":["${someAnchor}","bogus"],"keepDomains":["domA"],"reason":"local","confidence":0.8,"answer":null}`,
      r,
    );
    expect(decision.sufficientScope).toBe("domain");
    expect(decision.keepAnchors).toEqual([someAnchor]);
    expect(decision.confidence).toBeCloseTo(0.8);
  });
});

describe("runIntegral — path cache replay", () => {
  it("calls the judge once, then replays from cache", async () => {
    let calls = 0;
    const llm = async (): Promise<string> => {
      calls++;
      return '{"sufficientScope":"domain","keepAnchors":[],"keepDomains":["domA"],"reason":"r","confidence":0.7,"answer":null}';
    };
    const cache = createIntegralCache();
    const query = { entry: { ref: "domA", scope: "domain" as const }, range: { climb: "domain" as const } };

    const first = await runIntegral(ctx, query, { llm, cache, fingerprint: "fp1" });
    expect(first.cached).toBe(false);
    expect(first.decision).not.toBeNull();
    expect(calls).toBe(1);

    const second = await runIntegral(ctx, query, { llm, cache, fingerprint: "fp1" });
    expect(second.cached).toBe(true);
    expect(calls).toBe(1); // replayed — no second judge call

    // A changed fingerprint busts the cache (re-judges).
    const third = await runIntegral(ctx, query, { llm, cache, fingerprint: "fp2" });
    expect(third.cached).toBe(false);
    expect(calls).toBe(2);
  });

  it("returns the deterministic bundle alone when no judge llm is given", async () => {
    const report = await runIntegral(ctx, {
      entry: { ref: "domA", scope: "domain" },
      range: { climb: "domain" },
    });
    expect(report.decision).toBeNull();
    expect(report.cached).toBe(false);
    expect(report.result.domains.some((d) => d.name === "domA")).toBe(true);
  });
});
