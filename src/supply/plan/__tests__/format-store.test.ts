import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatPlan } from "../format.js";
import { formatPlanOkf } from "../format-okf.js";
import { latestPlanFile, loadPlan, planFilePath, planHash, savePlan } from "../store.js";
import { PLAN_VERSION, type Plan } from "../types.js";

const plan: Plan = {
  version: PLAN_VERSION,
  task: "切り絵のデモを実装する",
  taskHash: "0123456789abcdef",
  generatedAt: "2026-09-05T00:00:00.000Z",
  repos: ["pictor", "figmentum"],
  source: "llm",
  items: [
    {
      id: "pictor/samples-and-tools",
      dependsOn: ["pictor/kirie-demo"],
      uxCritical: true,
      repo: "pictor",
      domain: "samples-and-tools",
      status: "existing",
      responsibility: "デモ本体 (シーン組立・入力・ループ)",
      plannedPaths: ["samples/kirie/demo.cpp"],
      ownedPathPatterns: ["(^|/)samples/[^/]+$"],
      neededTypes: ["SampleScene", "DemoConfig"],
      layer: "samples",
      dataDefs: [{ kind: "type", name: "SampleScene", path: "samples/scene.h" }],
      duplicates: [{ name: "decals_demo", path: "samples/decals_demo.cpp", score: 0.4 }],
      exemplar: {
        anchor: "abc",
        name: "RunDecalsDemo",
        path: "samples/decals_demo.cpp",
        layer: "samples",
        references: 3,
      },
    },
    {
      id: "pictor/kirie-demo",
      dependsOn: [],
      uxCritical: false,
      repo: "pictor",
      domain: "kirie-demo",
      status: "new",
      responsibility: "切り絵デモのレイヤ構成",
      plannedPaths: ["samples/kirie/**"],
      ownedPathPatterns: [],
      neededTypes: [],
      layer: null,
      newDomain: {
        name: "kirie-demo",
        description: "切り絵デモのシーン構成",
        membership: [{ pathPattern: "(^|/)samples/kirie/[^/]+$" }],
      },
      dataDefs: [],
      duplicates: [],
      exemplar: null,
    },
  ],
  unresolved: [{ repo: "figmentum", subject: "写真の前処理", reason: "該当ドメインなし" }],
  questions: ["[figmentum] 写真の前処理はどのドメインですか。"],
  notes: [],
  layerWarnings: [],
};

describe("formatPlan", () => {
  it("renders one numbered item per domain with its enrichment", () => {
    const text = formatPlan(plan);
    expect(text).toContain("ドメイン計画: 切り絵のデモを実装する");
    expect(text).toContain("1. pictor/samples-and-tools\t[既存]");
    expect(text).toContain("データ定義: SampleScene (type, samples/scene.h)");
    expect(text).toContain("手本: samples/decals_demo.cpp:RunDecalsDemo");
    expect(text).toContain("新規ドメイン: pictor/kirie-demo");
    expect(text).toContain("紐付け不能:");
    expect(text).toContain("人間への質問:");
  });

  it("says plainly when no domain was found", () => {
    const text = formatPlan({ ...plan, items: [], unresolved: [], questions: [] });
    expect(text).toContain("着地ドメインを特定できませんでした");
    expect(text).toContain("新規ドメイン: なし");
  });
});

describe("formatPlanOkf", () => {
  it("emits OKF frontmatter plus one section per domain", () => {
    const text = formatPlanOkf(plan);
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toContain("type: plan");
    expect(text).toContain("service: pictor");
    expect(text).toContain("  kind: domain-plan");
    // A task containing a colon must not turn the title into a mapping.
    expect(formatPlanOkf({ ...plan, task: "a: b" })).toContain('title: "ドメイン計画: a: b"');
    expect(text).toContain("## pictor / samples-and-tools (既存)");
    expect(text).toContain("- 新規ドメイン説明 (LLM 下書き — 要人間レビュー): 切り絵デモのシーン構成");
  });
});

describe("plan store", () => {
  it("keys a plan by task + repos and reads it back", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-plan-store-"));
    expect(planHash("t", ["a", "b"])).toBe(planHash("t", ["b", "a"]));
    expect(planHash("t", ["a"])).not.toBe(planHash("u", ["a"]));

    const { written, failed } = await savePlan(plan, [{ id: "pictor", repoPath: root }]);
    expect(failed).toEqual([]);
    expect(written).toEqual([planFilePath(root, plan.taskHash)]);
    expect(JSON.parse(await readFile(written[0]!, "utf8")).task).toBe(plan.task);

    expect(await latestPlanFile(root)).toBe(written[0]);
    const loaded = await loadPlan(written[0]!);
    expect(loaded.items).toHaveLength(2);
    expect(loaded.storedForRepo).toBe("pictor");
  });

  it("rejects a task hash that could escape the plan directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-plan-path-"));
    expect(() => planFilePath(root, "../escape")).toThrow(/invalid plan task hash/);
  });

  it("rejects incompatible and structurally invalid persisted plans", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-plan-invalid-"));
    const wrongVersion = join(root, "wrong-version.json");
    const malformedItem = join(root, "malformed-item.json");
    await writeFile(wrongVersion, JSON.stringify({ ...plan, version: "plan-v0" }), "utf8");
    await writeFile(malformedItem, JSON.stringify({ ...plan, items: [{}] }), "utf8");

    await expect(loadPlan(wrongVersion)).rejects.toThrow(/does not match plan-v2/);
    await expect(loadPlan(malformedItem)).rejects.toThrow(/does not match plan-v2/);
  });

  it("has no latest plan in a repo that never planned", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-plan-empty-"));
    expect(await latestPlanFile(root)).toBeNull();
  });
});
