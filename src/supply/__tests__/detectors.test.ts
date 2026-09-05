import { describe, expect, it } from "vitest";
import type { AnalysisContext } from "../../core.js";
import type { AnchorId, FunctionNode } from "../../types.js";
import {
  contextDomainDetector,
  contextLayerRules,
  contextSiblingLookup,
  scoreDomains,
} from "../detectors.js";

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

/** Minimal graph stub: only fanCounts is read by the sibling lookup. */
function graphStub(fanIn: Record<string, number> = {}): AnalysisContext["graph"] {
  return {
    async fanCounts(id: AnchorId) {
      return { fanIn: fanIn[id as unknown as string] ?? 0, fanOut: 0 };
    },
  } as unknown as AnalysisContext["graph"];
}

function ctx(): AnalysisContext {
  const functions = [
    fn("1111111111111111", "claimSessionLock", "/repo/src/session.cpp"),
    fn("2222222222222222", "drawFrame", "/repo/ui/render.cpp"),
  ];
  return {
    repoPath: "/repo",
    graph: graphStub(),
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

/**
 * A Japanese-described ontology, like every LUDIARS repo: identifiers are
 * ASCII, meaning lives in `description`.
 */
function japaneseCtx(): AnalysisContext {
  const functions = [
    fn("3333333333333333", "TransformImage", "/repo/src/kirie/transform.cpp"),
    fn("4444444444444444", "UploadInvoice", "/repo/src/billing/invoice.cpp"),
  ];
  return {
    repoPath: "/repo",
    graph: graphStub(),
    files: [],
    functions,
    domains: [
      {
        domain: "kirie-transform",
        description: "写真を多層の切り絵に変換する画像処理。紙色パレットと積層エッジを持つ。",
        implementors: [a("3333333333333333")],
        violations: [],
        conforms: true,
      },
      {
        domain: "billing",
        description: "請求書の作成と送信。",
        implementors: [a("4444444444444444")],
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
        references: 0,
      },
    ]);
  });

  it("stamps each sibling with its OWN layer, not the domain's majority layer", async () => {
    const c = japaneseCtx();
    c.functions.push(fn("5555555555555555", "stbi_load", "/repo/third_party/stb_image.h"));
    c.domains![0]!.implementors.push(a("5555555555555555"));
    const siblings = await contextSiblingLookup(c)("kirie-transform", "src");
    expect(siblings.map((s) => s.layer).sort()).toEqual(["src", "third_party"]);
  });

  it("ranks a Japanese task against Japanese domain descriptions", async () => {
    // Regression for the reported failure: `where --task "切り絵のデモを実装する"`
    // returned no landing at all because descriptions were not scored.
    const detected = await contextDomainDetector(japaneseCtx())({
      description: "切り絵のデモを実装する",
    });
    expect(detected[0]).toBe("kirie-transform");
    expect(detected).not.toContain("billing");
  });

  it("scores domains with a stable, descending order", () => {
    const scored = scoreDomains(japaneseCtx(), "切り絵の変換を追加する");
    expect(scored[0]!.name).toBe("kirie-transform");
    expect(scored[0]!.score).toBeGreaterThan(0);
    for (let i = 1; i < scored.length; i++) {
      expect(scored[i - 1]!.score).toBeGreaterThanOrEqual(scored[i]!.score);
    }
  });
});
