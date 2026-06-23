/**
 * src/web-cache/scene-modules.test.ts — scene → domain → module assembly.
 */

import { describe, it, expect } from "vitest";
import { InMemoryCodeGraph } from "../graph/in-memory.js";
import type { CodeGraph } from "../graph/build.js";
import type { AnchorId, CodeNode, Edge, FunctionNode } from "../types.js";
import type { AnalysisContext } from "../core.js";
import type { DetectionResult } from "../domains/detect.js";
import { evaluateModulesFromGraph } from "../modules/evaluate.js";
import { createSceneModel } from "../integral/scene.js";
import { buildSceneModules } from "./scene-modules.js";

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
function fn(id: string, file: string): FunctionNode {
  return {
    id: a(id),
    name: id,
    signature: `void ${id}()`,
    sourceRange: { start: { line: 1, column: 0 }, end: { line: 2, column: 0 }, filePath: file },
  } as unknown as FunctionNode;
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
  const graph: CodeGraph = { nodes: new Map(nodes.map((n) => [n.id, n])), adjacency, reverseAdjacency, edges };
  return new InMemoryCodeGraph(graph);
}

describe("buildSceneModules", () => {
  it("decorates each domain's modules with functionCount, accesses, violations", async () => {
    const nodes = [
      node("f1", "/repo/combat/a.ts"),
      node("f2", "/repo/combat/b.ts"),
      node("f3", "/repo/ui/h.ts"),
    ];
    const edges: Edge[] = [{ from: a("f1"), to: a("f3"), kind: "calls" }];
    const graph = makeGraph(nodes, edges);
    const functions = [fn("f1", "/repo/combat/a.ts"), fn("f2", "/repo/combat/b.ts"), fn("f3", "/repo/ui/h.ts")];

    const domains: DetectionResult[] = [
      {
        domain: "combat",
        implementors: [a("f1"), a("f2")],
        violations: [{ ruleId: "r1", anchors: [a("f1")], evidence: "bad", severity: "error" }],
        conforms: false,
      },
      { domain: "ui", implementors: [a("f3")], violations: [], conforms: true },
    ];

    const ctx = { repoPath: "/repo", graph, functions, domains } as unknown as AnalysisContext;
    const { evaluation, index } = await evaluateModulesFromGraph(graph, functions);
    const scenes = createSceneModel([{ id: "s1", domains: ["combat"] }]);

    const out = await buildSceneModules(ctx, evaluation, index, scenes);

    expect(out.hasScenes).toBe(true);
    const combat = out.domains.find((d) => d.domain === "combat")!;
    expect(combat.scenes).toEqual(["s1"]);
    expect(combat.violationCount).toBe(1);

    const combatMod = combat.modules.find((m) => m.moduleId === "/repo/combat")!;
    expect(combatMod.functionCount).toBe(2);
    expect(combatMod.domainFunctionCount).toBe(2);
    expect(combatMod.violationCount).toBe(1); // violation anchor f1 lives here
    expect(combatMod.accesses.map((acc) => acc.targetModuleId)).toEqual(["/repo/ui"]);
    expect(combatMod.accesses[0]!.count).toBe(1);

    const ui = out.domains.find((d) => d.domain === "ui")!;
    expect(ui.scenes).toEqual([]);
    const uiMod = ui.modules.find((m) => m.moduleId === "/repo/ui")!;
    expect(uiMod.violationCount).toBe(0);
    expect(uiMod.accesses).toEqual([]);
  });
});
