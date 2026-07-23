/**
 * src/scenes/__tests__/derive.test.ts — call-graph scene derivation.
 */

import { describe, it, expect } from "vitest";
import { InMemoryCodeGraph } from "../../graph/in-memory.js";
import type { CodeGraph } from "../../graph/build.js";
import type { AnchorId, CodeNode, Edge, FunctionNode } from "../../types.js";
import type { AnalysisContext } from "../../core.js";
import type { DetectionResult } from "../../domains/detect.js";
import type { ScreenGraph, ScreenNode } from "../../screens/index.js";
import { deriveScenes } from "../derive.js";

function a(s: string): AnchorId {
  return s as AnchorId;
}
function node(id: string, file: string): CodeNode {
  return {
    id: a(id),
    name: id,
    kind: "function",
    sourceRange: { start: { line: 1, column: 0 }, end: { line: 2, column: 0 }, filePath: file },
  };
}
function fn(id: string): FunctionNode {
  return { id: a(id), name: id, signature: `void ${id}()` } as unknown as FunctionNode;
}
function makeGraph(nodes: CodeNode[], edges: Edge[]): InMemoryCodeGraph {
  const adjacency = new Map<AnchorId, Edge[]>();
  const reverseAdjacency = new Map<AnchorId, Edge[]>();
  for (const e of edges) {
    const f = adjacency.get(e.from) ?? [];
    f.push(e);
    adjacency.set(e.from, f);
    const t = reverseAdjacency.get(e.to) ?? [];
    t.push(e);
    reverseAdjacency.set(e.to, t);
  }
  const graph: CodeGraph = {
    nodes: new Map(nodes.map((n) => [n.id, n])),
    adjacency,
    reverseAdjacency,
    edges,
  };
  return new InMemoryCodeGraph(graph);
}

function screen(partial: Partial<ScreenNode> & { name: string; file: string }): ScreenNode {
  return {
    line: 1,
    kind: "page",
    stack: "web",
    contains: [],
    navigatesTo: [],
    reason: "test",
    domains: [],
    ...partial,
  };
}

function makeCtx(): AnalysisContext {
  // TitlePage (ui/title.ts: f1) -> f2 (combat/attack.ts) -> f3 (audio/bgm.ts)
  // ShopPage  (ui/shop.ts:  f4) -> f5 (economy/buy.ts)
  const nodes = [
    node("f1", "/repo/ui/title.ts"),
    node("f2", "/repo/combat/attack.ts"),
    node("f3", "/repo/audio/bgm.ts"),
    node("f4", "/repo/ui/shop.ts"),
    node("f5", "/repo/economy/buy.ts"),
  ];
  const edges: Edge[] = [
    { from: a("f1"), to: a("f2"), kind: "calls" },
    { from: a("f2"), to: a("f3"), kind: "calls" },
    { from: a("f4"), to: a("f5"), kind: "calls" },
  ];
  const domains: DetectionResult[] = [
    { domain: "ui", implementors: [a("f1"), a("f4")], violations: [], conforms: true },
    { domain: "combat", implementors: [a("f2")], violations: [], conforms: true },
    { domain: "audio", implementors: [a("f3")], violations: [], conforms: true },
    { domain: "economy", implementors: [a("f5")], violations: [], conforms: true },
  ];
  const files = [
    { path: "/repo/ui/title.ts", functions: [fn("f1")] },
    { path: "/repo/combat/attack.ts", functions: [fn("f2")] },
    { path: "/repo/audio/bgm.ts", functions: [fn("f3")] },
    { path: "/repo/ui/shop.ts", functions: [fn("f4")] },
    { path: "/repo/economy/buy.ts", functions: [fn("f5")] },
  ];
  return {
    repoPath: "/repo",
    graph: makeGraph(nodes, edges),
    files,
    functions: [fn("f1"), fn("f2"), fn("f3"), fn("f4"), fn("f5")],
    domains,
  } as unknown as AnalysisContext;
}

function makeScreens(): ScreenGraph {
  const screens = [
    screen({ name: "TitlePage", file: "ui/title.ts", domains: ["ui"], navigatesTo: ["ShopPage", "/unresolved"] }),
    screen({ name: "ShopPage", file: "ui/shop.ts", domains: ["ui"] }),
  ];
  return {
    screens,
    summary: { total: 2, byStack: { web: 2 }, byKind: { page: 2 }, edges: 2 },
  };
}

describe("deriveScenes", () => {
  it("attributes each scene to every domain in its call closure", async () => {
    const out = await deriveScenes(makeCtx(), makeScreens());
    const title = out.scenes.find((s) => s.id === "TitlePage")!;
    // Shallow attribution sees only "ui"; the closure walks f1→f2→f3.
    expect(title.directDomains).toEqual(["ui"]);
    expect(title.domains).toEqual(["audio", "combat", "ui"]);
    expect(title.entryFunctions).toBe(1);
    expect(title.reachedFunctions).toBe(3);

    const shop = out.scenes.find((s) => s.id === "ShopPage")!;
    expect(shop.domains).toEqual(["economy", "ui"]);
  });

  it("resolves navigation into scene transitions and drops unresolved targets", async () => {
    const out = await deriveScenes(makeCtx(), makeScreens());
    const title = out.scenes.find((s) => s.id === "TitlePage")!;
    expect(title.transitions).toEqual(["ShopPage"]);
    expect(out.summary.transitions).toBe(1);
  });

  it("respects maxDepth as a closure cap", async () => {
    const out = await deriveScenes(makeCtx(), makeScreens(), { maxDepth: 1 });
    const title = out.scenes.find((s) => s.id === "TitlePage")!;
    // Depth 1 reaches f2 (combat) but not f3 (audio).
    expect(title.domains).toEqual(["combat", "ui"]);
    expect(title.reachedFunctions).toBe(2);
  });

  it("keeps scene-only screens (no file) with empty entries", async () => {
    const ctx = makeCtx();
    const graph: ScreenGraph = {
      screens: [screen({ name: "Battle", file: "", kind: "scene", stack: "unity" })],
      summary: { total: 1, byStack: { unity: 1 }, byKind: { scene: 1 }, edges: 0 },
    };
    const out = await deriveScenes(ctx, graph);
    expect(out.scenes).toHaveLength(1);
    expect(out.scenes[0]!.entryFunctions).toBe(0);
    expect(out.scenes[0]!.domains).toEqual([]);
    expect(out.summary.withEntries).toBe(0);
  });

  it("is deterministic: same inputs give identical JSON", async () => {
    const one = await deriveScenes(makeCtx(), makeScreens());
    const two = await deriveScenes(makeCtx(), makeScreens());
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });
});
