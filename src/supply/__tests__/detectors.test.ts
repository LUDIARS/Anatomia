import { describe, expect, it } from "vitest";
import type { AnalysisContext } from "../../core.js";
import type { AnchorId, FunctionNode } from "../../types.js";
import { contextDomainDetector, contextLayerRules, contextSiblingLookup } from "../detectors.js";

function a(id: string): AnchorId {
  return id as AnchorId;
}

function fn(id: string, name: string, filePath: string): FunctionNode {
  return {
    id: a(id),
    name,
    signature: `void ${name}()`,
    sourceRange: {
      filePath,
      start: { line: 3, column: 0 },
      end: { line: 5, column: 0 },
    },
    bodyAst: {} as FunctionNode["bodyAst"],
  };
}

function ctx(): AnalysisContext {
  const functions = [
    fn("1111111111111111", "claimSessionLock", "/repo/src/session.cpp"),
    fn("2222222222222222", "drawFrame", "/repo/ui/render.cpp"),
  ];
  return {
    repoPath: "/repo",
    graph: {} as AnalysisContext["graph"],
    files: [],
    functions,
    domains: [
      {
        domain: "session-coordination",
        implementors: [a("1111111111111111")],
        violations: [],
        conforms: true,
      },
      {
        domain: "rendering",
        implementors: [a("2222222222222222")],
        violations: [],
        conforms: true,
      },
    ],
  };
}

describe("context landing detectors", () => {
  it("detects domains from task text and implementor names", async () => {
    const detector = contextDomainDetector(ctx());
    expect(await detector({ description: "add session lock release" })).toEqual([
      "session-coordination",
    ]);
    expect(await detector({ description: "unrelated billing export" })).toEqual([]);
  });

  it("maps siblings and inferred layers from implementors", async () => {
    const c = ctx();
    const layerRules = contextLayerRules(c);
    const siblings = contextSiblingLookup(c);
    expect(layerRules.layerFor("session-coordination")).toBe("src");
    expect(await siblings("session-coordination", null)).toEqual([
      {
        anchor: a("1111111111111111"),
        name: "claimSessionLock",
        layer: "src",
      },
    ]);
  });
});
