/**
 * src/supply/gates/plan_conformance.ts — advisory gate: diff vs. domain plan.
 *
 * The verify-side half of `anatomia plan` (design §3.2). It answers one
 * question: are the files this diff touched inside the domains the task was
 * planned into? A file outside every planned path and every target domain's
 * membership is reported so the author decides which domain it belongs to and
 * adds the membership — the same binding Revisor blocks on later.
 *
 * ADVISORY by construction: a plan is a forecast made before the code existed,
 * and implementation legitimately discovers work the plan did not foresee.
 * Failing a PR for that would make the plan a cage instead of a briefing, so the
 * gate never contributes to `verdict.pass`.
 *
 * It is also NOT part of `buildDefaultGates`: the other five gates run per
 * changed file (buildVerdict splits a multi-file diff), while conformance is a
 * property of the WHOLE diff — a file is only "off plan" once every plan item
 * has been considered. core.buildVerdict therefore runs it once, over all the
 * diff's paths, and appends the result.
 *
 * SRP: GateResult shaping + severity. The comparison lives in
 * supply/plan/conformance.ts.
 */

import type { GateResult } from "../../types.js";
import { evaluatePlanConformance } from "../plan/conformance.js";
import type { Plan } from "../plan/types.js";

/** Name this gate reports under. */
export const PLAN_CONFORMANCE_GATE = "plan_conformance";

/** Run the plan check over a diff's changed paths (repo-relative). */
export function planConformanceGate(
  plan: Plan,
  changedPaths: string[],
  options: { repo?: string } = {},
): GateResult {
  const conformance = evaluatePlanConformance(plan, changedPaths, options);
  const suggestions: string[] = [];
  for (const path of conformance.offPlan) {
    suggestions.push(
      `計画外: ${path} → どのドメインに入れるか決めて membership を足してください` +
        ` (計画: ${plan.task})`,
    );
  }
  for (const domain of conformance.undeclaredNewDomains) {
    suggestions.push(
      `新規ドメイン "${domain}" の spec/domains/*.domain.json が diff にありません。` +
        `同じ PR で宣言してください`,
    );
  }
  return {
    gate: PLAN_CONFORMANCE_GATE,
    pass: conformance.pass,
    anchors: [],
    suggestion: suggestions.length > 0 ? suggestions.join("\n") : null,
  };
}
