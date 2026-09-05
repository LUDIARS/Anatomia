import { describe, expect, it } from "vitest";
import { buildPlan } from "../build.js";
import { planRepo } from "./helpers.js";

const now = (): Date => new Date("2026-09-05T00:00:00.000Z");

describe("buildPlan", () => {
  it("uses the LLM decomposition and enriches it from the analysis graph", async () => {
    const llm = async (): Promise<string> =>
      JSON.stringify({
        items: [
          {
            repo: "figmentum",
            domain: "kirie-transform",
            status: "existing",
            responsibility: "写真を多層の切り絵へ変換する",
            plannedPaths: ["src/kirie/layers.cpp"],
            neededTypes: ["KirieLayer"],
          },
        ],
        unresolved: [],
        questions: [],
      });

    const plan = await buildPlan("切り絵のデモを実装する", [planRepo()], { llm: { llm }, now });

    expect(plan.source).toBe("llm");
    expect(plan.items).toHaveLength(1);
    const item = plan.items[0]!;
    expect(item.domain).toBe("kirie-transform");
    expect(item.plannedPaths).toEqual(["src/kirie/layers.cpp"]);
    // Enrichment is deterministic: the domain's own types, and the src exemplar
    // rather than the far more referenced vendored header.
    expect(item.dataDefs.map((d) => d.name)).toContain("KirieLayer");
    expect(item.exemplar?.name).toBe("TransformImage");
    expect(item.exemplar?.layer).toBe("src");
    // This fixture has no on-disk declarations, so the candidates come from the
    // detected domains and carry no declared paths (see collect.test.ts).
    expect(item.ownedPathPatterns).toEqual([]);
  });

  it("falls back to the deterministic decomposition and SAYS it fell back", async () => {
    const llm = async (): Promise<string> => {
      throw new Error("claude CLI failed to spawn");
    };
    const plan = await buildPlan("切り絵の変換を実装する", [planRepo()], { llm: { llm }, now });

    expect(plan.source).toBe("deterministic");
    expect(plan.notes.join("\n")).toMatch(/フォールバック/);
    expect(plan.items.map((i) => i.domain)).toContain("kirie-transform");
  });

  it("--no-llm never calls the model", async () => {
    let called = false;
    const llm = async (): Promise<string> => {
      called = true;
      return "{}";
    };
    const plan = await buildPlan("切り絵の変換", [planRepo()], { noLlm: true, llm: { llm }, now });
    expect(called).toBe(false);
    expect(plan.source).toBe("deterministic");
  });

  it("records an unresolved piece and a question when nothing matches", async () => {
    const plan = await buildPlan("quarterly revenue forecasting", [planRepo()], {
      noLlm: true,
      now,
    });
    expect(plan.items).toHaveLength(0);
    expect(plan.unresolved[0]?.repo).toBe("figmentum");
    expect(plan.questions[0]).toMatch(/どのドメインに着地しますか/);
  });

  it("carries a new-domain proposal through with a review question", async () => {
    const llm = async (): Promise<string> =>
      JSON.stringify({
        items: [
          {
            repo: "figmentum",
            domain: "kirie-demo",
            status: "new",
            responsibility: "切り絵デモのシーン組立",
            plannedPaths: ["samples/kirie/**"],
            neededTypes: ["DemoConfig"],
            newDomain: {
              name: "kirie-demo",
              description: "切り絵デモのシーン・入力・ループ",
              membership: [{ pathPattern: "(^|/)samples/kirie/[^/]+$" }],
            },
          },
        ],
      });
    const plan = await buildPlan("切り絵のデモを実装する", [planRepo()], { llm: { llm }, now });
    const item = plan.items[0]!;
    expect(item.status).toBe("new");
    expect(item.newDomain?.membership[0]?.pathPattern).toBe("(^|/)samples/kirie/[^/]+$");
    // A new domain has no analysed members yet, so nothing is claimed about them.
    expect(item.dataDefs).toEqual([]);
    expect(item.exemplar).toBeNull();
    expect(plan.questions.join("\n")).toMatch(/新規ドメイン "kirie-demo"/);
  });

  it("is stable for the same task and repos", async () => {
    const a = await buildPlan("切り絵の変換", [planRepo()], { noLlm: true, now });
    const b = await buildPlan("切り絵の変換", [planRepo()], { noLlm: true, now });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
