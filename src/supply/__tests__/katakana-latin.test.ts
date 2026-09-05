import { describe, expect, it } from "vitest";
import { latinTokensForKatakana } from "../katakana-latin.js";
import { tokenizeRelevanceText } from "../relevance.js";
import { scoreDomains } from "../detectors.js";
import type { AnalysisContext } from "../../core.js";
import type { AnchorId } from "../../types.js";

function graphStub(): AnalysisContext["graph"] {
  return {
    async fanCounts() { return { fanIn: 0, fanOut: 0 }; },
  } as unknown as AnalysisContext["graph"];
}

const a = (hex: string): AnchorId => hex as unknown as AnchorId;

function fn(id: string, name: string, filePath: string) {
  return {
    id: a(id),
    name,
    signature: `void ${name}()`,
    sourceRange: { filePath, start: { line: 0, column: 0 }, end: { line: 1, column: 0 } },
  } as unknown as AnalysisContext["functions"][number];
}

/**
 * A Pictor-shaped fixture: the description says `demo` in latin, the task says
 * デモ in katakana (the 2026-09-05 measurement in the task document).
 */
function ctx(): AnalysisContext {
  return {
    repoPath: "/repo",
    graph: graphStub(),
    files: [],
    functions: [
      fn("3333333333333333", "RunDecalsDemo", "/repo/samples/decals_demo.cpp"),
      fn("4444444444444444", "UploadInvoice", "/repo/src/billing/invoice.cpp"),
    ],
    domains: [
      {
        domain: "samples-and-tools",
        description: "demo アプリ群、ベンチマーク、変換/検証ツール。",
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
  } as unknown as AnalysisContext;
}

describe("latinTokensForKatakana", () => {
  it("finds a table word inside a longer Japanese run", () => {
    expect(latinTokensForKatakana("切り絵のシェーダを修正")).toEqual(["shader"]);
  });

  it("emits each latin word once however often the katakana appears", () => {
    expect(latinTokensForKatakana("デモとデモの比較")).toEqual(["demo"]);
  });

  it("passes an unknown katakana word through untouched", () => {
    expect(latinTokensForKatakana("フーバリゼーション")).toEqual([]);
  });
});

describe("tokenizeRelevanceText", () => {
  it("adds the latin spelling alongside the original Japanese tokens", () => {
    const tokens = tokenizeRelevanceText("切り絵のデモを実装する");
    expect(tokens).toContain("demo");
    expect(tokens).toContain("切り絵のデモを実装する");
  });
});

describe("scoreDomains with katakana loanwords", () => {
  it("reaches a domain whose description spells the loanword in latin", () => {
    const scored = scoreDomains(ctx(), "切り絵のデモを実装する");
    expect(scored.map((hit) => hit.name)).toContain("samples-and-tools");
  });

  it("does not pull in an unrelated domain", () => {
    const scored = scoreDomains(ctx(), "デモを実装する");
    expect(scored.map((hit) => hit.name)).not.toContain("billing");
  });
});
