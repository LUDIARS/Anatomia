import { describe, expect, it } from "vitest";
import { rankExemplars, rankSpecClauses, tokenizeRelevanceText } from "../relevance.js";
import type { AnchorId, FunctionNode, SpecClause } from "../../types.js";

function a(id: string): AnchorId {
  return id as AnchorId;
}

function clause(id: string, heading: string, text: string): SpecClause {
  return { id, sourceFile: "spec.md", heading, text, embedding: null };
}

function fn(id: string, name: string, line: number): FunctionNode {
  return {
    id: a(id),
    name,
    signature: `void ${name}()`,
    sourceRange: {
      filePath: `/repo/${name}.cpp`,
      start: { line, column: 0 },
      end: { line: line + 1, column: 0 },
    },
    bodyAst: {} as FunctionNode["bodyAst"],
  };
}

describe("relevance ranking", () => {
  it("ranks related spec clauses first and stabilizes ties by id", () => {
    const ranked = rankSpecClauses("session lock release", [
      clause("c", "Render", "draw frame"),
      clause("b", "Session", "release claim"),
      clause("a", "Session", "lock claim"),
    ]);
    expect(ranked.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("tokenizes CJK text into usable tokens", () => {
    const tokens = tokenizeRelevanceText("仕様書 解析 ドメイン");
    expect(tokens).toContain("仕様書");
    expect(tokens).toContain("解");
  });

  it("ranks exemplars by name/signature and falls back to source order on zero hits", () => {
    const functions = [fn("b", "renderFrame", 20), fn("a", "claimSessionLock", 10)];
    expect(rankExemplars("session lock", functions).map((f) => f.name)).toEqual([
      "claimSessionLock",
    ]);
    expect(rankExemplars("unmatched", functions).map((f) => f.name)).toEqual([
      "renderFrame",
      "claimSessionLock",
    ]);
  });
});
