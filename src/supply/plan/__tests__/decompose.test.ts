import { describe, expect, it } from "vitest";
import { buildDecomposePrompt, parseDecomposition } from "../decompose-llm.js";
import { decomposeDeterministically } from "../decompose-fallback.js";
import { planCandidates, planRepo } from "./helpers.js";

describe("buildDecomposePrompt", () => {
  it("carries the task and every candidate's description verbatim", () => {
    const prompt = buildDecomposePrompt("切り絵のデモを実装する", planCandidates());
    expect(prompt).toContain("TASK: 切り絵のデモを実装する");
    expect(prompt).toContain("写真を多層の切り絵に変換する画像処理");
    expect(prompt).toContain("(^|/)src/kirie/[^/]+$");
  });
});

describe("parseDecomposition", () => {
  const candidates = planCandidates();

  it("accepts a fenced answer", () => {
    const answer = [
      "```json",
      JSON.stringify({
        items: [
          {
            repo: "figmentum",
            domain: "kirie-transform",
            status: "existing",
            responsibility: "変換",
            plannedPaths: ["src/kirie/x.cpp"],
            neededTypes: ["KirieLayer"],
          },
        ],
      }),
      "```",
    ].join("\n");
    const result = parseDecomposition(answer, candidates);
    expect(result.items[0]!.domain).toBe("kirie-transform");
  });

  it("drops a hallucinated domain into unresolved instead of planning against it", () => {
    const answer = JSON.stringify({
      items: [
        { repo: "figmentum", domain: "not-declared", status: "existing", responsibility: "何か" },
        { repo: "other-repo", domain: "billing", status: "existing", responsibility: "請求" },
      ],
      unresolved: [],
      questions: [],
    });
    const result = parseDecomposition(answer, candidates);
    expect(result.items).toHaveLength(0);
    expect(result.unresolved.map((u) => u.reason)).toEqual([
      expect.stringContaining("宣言されていないドメイン"),
      expect.stringContaining("未知のリポジトリ"),
    ]);
  });

  it("throws when the answer is not JSON at all", () => {
    expect(() => parseDecomposition("sorry, I cannot help with that", candidates)).toThrow(
      /no JSON object/,
    );
  });

  it("throws when the answer carries neither items nor unresolved", () => {
    expect(() => parseDecomposition(JSON.stringify({ items: [] }), candidates)).toThrow(
      /no usable items/,
    );
  });

  it("ignores malformed array entries instead of crashing on them", () => {
    const answer = JSON.stringify({
      items: [null, 7],
      unresolved: [null, { repo: "figmentum", subject: "unknown", reason: "not mapped" }],
    });
    const result = parseDecomposition(answer, candidates);
    expect(result.items).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
  });
});

describe("decomposeDeterministically", () => {
  it("ranks declared domains against a Japanese task", () => {
    const result = decomposeDeterministically(
      "切り絵の変換を実装する",
      [planRepo()],
      planCandidates(),
    );
    expect(result.items[0]!.domain).toBe("kirie-transform");
    // With no LLM there is no per-piece responsibility to invent, so the
    // domain's own description stands in.
    expect(result.items[0]!.responsibility).toMatch(/切り絵/);
    expect(result.items[0]!.plannedPaths).toEqual([]);
  });

  it("asks the human instead of returning an empty plan", () => {
    const result = decomposeDeterministically(
      "quarterly revenue forecasting",
      [planRepo()],
      planCandidates(),
    );
    expect(result.items).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
    expect(result.questions).toHaveLength(1);
  });

  it("can choose a matching declared domain before it has implementors", () => {
    const repo = planRepo();
    repo.ctx.domains!.push({
      domain: "forecasting",
      description: "四半期の売上予測と需要計画。",
      implementors: [],
      violations: [],
      conforms: true,
    });
    const candidates = [
      ...planCandidates(),
      {
        repo: repo.id,
        name: "forecasting",
        description: "四半期の売上予測と需要計画。",
        pathPatterns: ["(^|/)src/forecast/[^/]+$"],
        implementors: 0,
      },
    ];
    const result = decomposeDeterministically("四半期の売上予測", [repo], candidates);
    expect(result.items[0]?.domain).toBe("forecasting");
  });
});
