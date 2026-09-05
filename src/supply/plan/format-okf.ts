/**
 * src/supply/plan/format-okf.ts — Plan → OKF document (design §5, A-6).
 *
 * When a task is DELEGATED, the domain definitions have to travel with the
 * instructions: the implementer works in a fresh session that has not run
 * `plan`, and "put it in the right domain" is unactionable without the domain's
 * description, the paths it owns and the definitions it already has. This
 * renders the plan as an AIFormat/OKF document (YAML frontmatter + one section
 * per domain) so Concordia can embed it at the head of a delegation prompt.
 *
 * SRP: Plan → OKF Markdown. The plan's content is decided elsewhere.
 */

import type { Plan, PlanItem } from "./types.js";

/** Render the plan as an OKF document (frontmatter + per-domain sections). */
export function formatPlanOkf(plan: Plan): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`title: ${yamlScalar(`ドメイン計画: ${plan.task}`)}`);
  lines.push("type: plan");
  lines.push(`service: ${yamlScalar(plan.repos[0] ?? "unknown")}`);
  lines.push(`domain: ${yamlScalar(plan.items[0]?.domain ?? "unassigned")}`);
  lines.push("status: draft");
  lines.push("tags:");
  lines.push("  - domain-plan");
  for (const tag of uniqueTags(plan)) lines.push(`  - ${yamlScalar(tag)}`);
  lines.push("x-anatomia:");
  lines.push("  kind: domain-plan");
  lines.push(`  taskHash: ${plan.taskHash}`);
  lines.push(`  source: ${plan.source}`);
  // Quoted: an ISO timestamp is a colon-bearing scalar YAML would otherwise
  // reinterpret as its own timestamp type.
  lines.push(`  generatedAt: "${plan.generatedAt}"`);
  lines.push("  repos:");
  for (const repo of plan.repos) lines.push(`    - ${yamlScalar(repo)}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ドメイン計画: ${plan.task}`);
  lines.push("");

  if (plan.items.length === 0) {
    lines.push("着地ドメインを特定できませんでした。");
  }
  for (const item of plan.items) lines.push(...okfSection(item));

  if (plan.unresolved.length > 0) {
    lines.push("## 紐付け不能");
    lines.push("");
    for (const entry of plan.unresolved) {
      lines.push(`- [${entry.repo || "?"}] ${entry.subject} — ${entry.reason}`);
    }
    lines.push("");
  }
  if (plan.questions.length > 0) {
    lines.push("## 人間への質問 (回答を待たずに実装してよい)");
    lines.push("");
    for (const question of plan.questions) lines.push(`- ${question}`);
    lines.push("");
  }
  if (plan.notes.length > 0) {
    lines.push("## 備考");
    lines.push("");
    for (const note of plan.notes) lines.push(`- ${note}`);
    lines.push("");
  }
  return lines.join("\n");
}

function okfSection(item: PlanItem): string[] {
  const lines: string[] = [];
  lines.push(`## ${item.repo} / ${item.domain} (${item.status === "new" ? "新規" : "既存"})`);
  lines.push("");
  lines.push(`- 責務: ${item.responsibility}`);
  if (item.layer) lines.push(`- layer: ${item.layer}`);
  if (item.plannedPaths.length > 0) lines.push(`- 予定パス: ${item.plannedPaths.join(", ")}`);
  if (item.neededTypes.length > 0) lines.push(`- 必要な型: ${item.neededTypes.join(", ")}`);
  if (item.newDomain) {
    lines.push(`- 新規ドメイン説明 (要人間レビュー): ${item.newDomain.description}`);
    lines.push(
      `- membership: ${item.newDomain.membership.map((m) => m.pathPattern).join(", ") || "(未提案)"}`,
    );
  }
  if (item.dataDefs.length > 0) {
    lines.push("- データ定義:");
    for (const def of item.dataDefs) {
      lines.push(`  - ${def.name} (${def.kind}) — ${def.path}`);
    }
  }
  if (item.exemplar) {
    lines.push(`- 手本: ${item.exemplar.path}:${item.exemplar.name} (被参照 ${item.exemplar.references})`);
  }
  if (item.duplicates.length > 0) {
    lines.push("- 重複候補:");
    for (const dup of item.duplicates) lines.push(`  - ${dup.path}:${dup.name} (${dup.score})`);
  }
  lines.push("");
  return lines;
}

/** Domain names as tags, so a plan is searchable by the domains it touches. */
function uniqueTags(plan: Plan): string[] {
  return [...new Set(plan.items.map((item) => item.domain))].sort();
}

/**
 * Quote a YAML scalar when it holds a character that would change the parse
 * (`:`, `#`, quotes, leading indicators). Plans carry free Japanese text, and a
 * task with a colon in it must not silently turn into a mapping.
 */
function yamlScalar(value: string): string {
  const flat = value.replace(/[\r\n]+/g, " ").trim();
  if (flat === "") return '""';
  if (/^[^\s#&*!|>%@`{}\[\],'"-][^:#]*$/.test(flat) && !/[:#]\s/.test(flat)) return flat;
  return `"${flat.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
