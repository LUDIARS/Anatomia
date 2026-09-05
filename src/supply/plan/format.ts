/**
 * src/supply/plan/format.ts — Human-readable plan rendering (design §2).
 *
 * The default output of `anatomia plan`, and the text the supply hook prefixes
 * to a coding prompt. Shape follows the design's worked example: one numbered
 * item per domain, with its data definitions, exemplar and duplicate candidates
 * indented under it, then new domains, unresolved pieces and questions.
 *
 * SRP: Plan → Markdown. No pipeline logic.
 *
 * @spec パイプライン（`src/supply/plan/`）
 */

import type { Plan, PlanItem } from "./types.js";

/** Render a plan as the Markdown block shown to a human (or an AI author). */
export function formatPlan(plan: Plan): string {
  const lines: string[] = [];
  lines.push(`ドメイン計画: ${plan.task}`);
  if (plan.items.length === 0) {
    lines.push("  (着地ドメインを特定できませんでした)");
  }
  plan.items.forEach((item, index) => {
    lines.push(...formatItem(item, index + 1));
  });

  const newDomains = plan.items.filter((item) => item.status === "new");
  lines.push(
    newDomains.length === 0
      ? "  新規ドメイン: なし"
      : `  新規ドメイン: ${newDomains.map((item) => `${item.repo}/${item.domain}`).join(", ")}`,
  );

  if (plan.layerWarnings.length > 0) {
    lines.push("  層間依存の警告 (書く前の注意 — plan は gate ではありません):");
    for (const warning of plan.layerWarnings) {
      lines.push(`    - ${warning.fromItemId} -> ${warning.toItemId}: ${warning.reason}`);
    }
  }
  if (plan.unresolved.length > 0) {
    lines.push("  紐付け不能:");
    for (const entry of plan.unresolved) {
      lines.push(`    - [${entry.repo || "?"}] ${entry.subject} — ${entry.reason}`);
    }
  }
  if (plan.questions.length > 0) {
    lines.push("  人間への質問:");
    for (const question of plan.questions) lines.push(`    - ${question}`);
  }
  if (plan.notes.length > 0) {
    lines.push("  備考:");
    for (const note of plan.notes) lines.push(`    - ${note}`);
  }
  lines.push(`  (source: ${plan.source} / hash: ${plan.taskHash})`);
  return lines.join("\n");
}

function formatItem(item: PlanItem, ordinal: number): string[] {
  const lines: string[] = [];
  const status = item.status === "new" ? "新規" : "既存";
  const layer = item.layer ? ` layer=${item.layer}` : "";
  lines.push(
    `  ${ordinal}. ${item.repo}/${item.domain}\t[${status}]${layer}${item.uxCritical ? "  [UX 直結]" : ""}  ${item.responsibility}`,
  );
  lines.push(`       id: ${item.id}${item.dependsOn.length > 0 ? ` / 依存: ${item.dependsOn.join(", ")}` : ""}`);
  if (item.uxCritical) {
    lines.push("       レビュー観点: 画面遷移・入力・エラー表示 (テスト候補は必須)");
  }
  if (item.plannedPaths.length > 0) {
    lines.push(`       予定パス: ${item.plannedPaths.join(", ")}`);
  }
  if (item.neededTypes.length > 0) {
    lines.push(`       必要な型: ${item.neededTypes.join(", ")}`);
  }
  if (item.dataDefs.length > 0) {
    lines.push(
      `       データ定義: ${item.dataDefs
        .map((def) => `${def.name} (${def.kind}, ${def.path})`)
        .join(", ")}`,
    );
  }
  if (item.exemplar) {
    lines.push(`       手本: ${item.exemplar.path}:${item.exemplar.name} (被参照 ${item.exemplar.references})`);
  }
  lines.push(
    item.duplicates.length > 0
      ? `       重複候補: ${item.duplicates
          .map((dup) => `${dup.path}:${dup.name} (${dup.score})`)
          .join(", ")}`
      : "       重複候補: なし",
  );
  if (item.newDomain) {
    const membership = item.newDomain.membership.map((m) => m.pathPattern).join(", ");
    lines.push(`       新規ドメイン定義案 (LLM 下書き — 要人間レビュー): ${item.newDomain.description}`);
    lines.push(`       membership: ${membership || "(未提案 — 人間が決める)"}`);
  }
  return lines;
}
