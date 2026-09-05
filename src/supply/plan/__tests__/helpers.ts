/**
 * Shared fixtures for the plan tests: a hand-built AnalysisContext with a
 * Japanese-described ontology, mirroring a real LUDIARS repo (ASCII
 * identifiers, Japanese domain descriptions).
 */

import type { AnalysisContext } from "../../../core.js";
import type { AnchorId, FileNode, FunctionNode } from "../../../types.js";
import type { PlanRepo } from "../collect.js";
import type { PlanDomainCandidate } from "../types.js";

export function anchor(id: string): AnchorId {
  return id as AnchorId;
}

export function fn(id: string, name: string, filePath: string): FunctionNode {
  return {
    id: anchor(id),
    name,
    signature: `void ${name}()`,
    sourceRange: { filePath, start: { line: 1, column: 0 }, end: { line: 2, column: 0 } },
  };
}

export function file(path: string, types: string[], functions: FunctionNode[]): FileNode {
  return {
    path,
    hash: null,
    functions,
    types: types.map((name) => ({ name, bases: [], filePath: path })),
  };
}

/** fanCounts is the only graph method the plan pipeline reads. */
export function graphStub(fanIn: Record<string, number> = {}): AnalysisContext["graph"] {
  return {
    async fanCounts(id: AnchorId) {
      return { fanIn: fanIn[id as unknown as string] ?? 0, fanOut: 0 };
    },
  } as unknown as AnalysisContext["graph"];
}

/** A one-repo fixture: two domains, one of them the "切り絵" image transform. */
export function planRepo(id = "figmentum"): PlanRepo {
  const transform = fn("1111", "TransformImage", "/repo/src/kirie/transform.cpp");
  const vendored = fn("0000", "stbi_load", "/repo/third_party/stb_image.h");
  const invoice = fn("2222", "UploadInvoice", "/repo/src/billing/invoice.cpp");
  const functions = [transform, vendored, invoice];
  const ctx: AnalysisContext = {
    repoPath: "/repo",
    graph: graphStub({ "1111": 5, "0000": 40, "2222": 1 }),
    files: [
      file("/repo/src/kirie/transform.cpp", ["KirieLayer", "PaperPalette"], [transform]),
      file("/repo/third_party/stb_image.h", [], [vendored]),
      file("/repo/src/billing/invoice.cpp", ["Invoice"], [invoice]),
    ],
    functions,
    domains: [
      {
        domain: "kirie-transform",
        description: "写真を多層の切り絵に変換する画像処理。紙色パレットと積層エッジを持つ。",
        implementors: [anchor("1111"), anchor("0000")],
        violations: [],
        conforms: true,
      },
      {
        domain: "billing",
        description: "請求書の作成と送信。",
        implementors: [anchor("2222")],
        violations: [],
        conforms: true,
      },
    ],
  };
  return { id, repoPath: "/repo", ctx, ontologyDir: undefined };
}

/** The candidates `collectCandidates` would return for {@link planRepo}. */
export function planCandidates(repo = "figmentum"): PlanDomainCandidate[] {
  return [
    {
      repo,
      name: "billing",
      description: "請求書の作成と送信。",
      pathPatterns: ["(^|/)src/billing/[^/]+$"],
      implementors: 1,
    },
    {
      repo,
      name: "kirie-transform",
      description: "写真を多層の切り絵に変換する画像処理。紙色パレットと積層エッジを持つ。",
      pathPatterns: ["(^|/)src/kirie/[^/]+$"],
      implementors: 2,
    },
  ];
}
