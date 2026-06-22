/**
 * src/integral/agent.ts — Phase B: the Sonnet scope-judging agent.
 *
 * Integral search (Phase A) is deliberately generous: it climbs the whole chain
 * within range. This agent then judges HOW FAR the caller actually needs to load
 * for its task — the design hands the "どこまで必要か" decision to a Sonnet agent.
 * The agent input is the fixed 3-part format (entry+scope / related graph info /
 * exploration range) plus the Phase-A bundle; the output is a ScopeDecision. When
 * the agent can resolve the task from the bundle alone, it returns a self-
 * contained `answer` (the blackbox case) so the caller need not reason further.
 *
 * SRP: prompt assembly + response parsing only. The LLM is injected (LLMClient);
 * caching is cache.ts, orchestration is run.ts. No API client is hardcoded.
 */

import type { AnchorId } from "../types.js";
import type { LLMClient } from "../domains/card.js";
import type { IntegralQuery, IntegralResult, IntegralScope, ScopeDecision } from "./types.js";

/**
 * Prompt-template version. BUMP whenever assembleJudgePrompt changes, so a shared
 * path cache never serves a decision distilled with an older prompt.
 */
export const JUDGE_PROMPT_VERSION = "1";

const SCOPES = ["function", "domain", "scene", "scene-adjacent"] as const;

/** Build the deterministic 3-part judge prompt from the query + Phase-A result. */
export function assembleJudgePrompt(query: IntegralQuery, result: IntegralResult): string {
  const lines: string[] = [];
  lines.push(
    "You are Anatomia's integral-search scope judge. Decide how much of the supplied",
    "context an engineer must load to work on the entry point — no more, no less.",
    "",
    "① ENTRY (initial look-at point + scope):",
    `  ref=${query.entry.ref}  scope=${query.entry.scope}`,
    "",
    "② RELATED GRAPH INFO (what the deterministic search surfaced):",
    `  seeds (${result.seeds.length}): ${result.seeds.slice(0, 12).join(", ")}`,
    `  domains (${result.domains.length}):`,
  );
  for (const d of result.domains) {
    lines.push(`    - ${d.name} [${d.via}] (${d.anchors.length} anchors)`);
  }
  lines.push(`  scenes (${result.scenes.length}):`);
  for (const s of result.scenes) {
    const coin = s.coincidesWithDomain ? ` ≈domain:${s.coincidesWithDomain}` : "";
    lines.push(`    - ${s.id}${s.label ? ` (${s.label})` : ""} domains=[${s.domains.join(", ")}]${coin}`);
  }
  lines.push(`  surfaced functions (${result.anchors.length}, by layer):`);
  for (const a of result.anchors.slice(0, 40)) {
    lines.push(`    - ${a.name} [${a.via}] @ ${a.file}:${a.line}`);
  }
  if (result.anchors.length > 40) lines.push(`    … and ${result.anchors.length - 40} more`);
  lines.push(`  spec clauses (${result.specClauses.length}):`);
  for (const c of result.specClauses.slice(0, 8)) lines.push(`    - ${c.heading}`);
  lines.push(
    "",
    "③ EXPLORATION RANGE:",
    `  ${JSON.stringify(query.range ?? {})}`,
    result.truncated ? `  (search was truncated: ${result.stopReason})` : "",
    "",
    "Return a JSON object with fields:",
    `  sufficientScope: one of ${SCOPES.map((s) => `"${s}"`).join(" | ")}`,
    "  keepAnchors: string[]   (anchor ids essential to the task; subset of the above)",
    "  keepDomains: string[]   (domain names essential to the task)",
    "  reason: string          (one or two sentences)",
    "  confidence: number      (0..1 that the kept scope is sufficient)",
    "  answer: string | null   (a self-contained answer IF the bundle already",
    "                           resolves the task; otherwise null)",
  );
  return lines.filter((l) => l !== undefined).join("\n");
}

/** Coerce a possibly-stringy / possibly-array field into a string[]. */
function asStringArray(x: unknown): string[] {
  if (Array.isArray(x)) return x.map(String);
  if (typeof x === "string" && x.trim()) return [x];
  return [];
}

function asScope(x: unknown): IntegralScope | "scene-adjacent" {
  return (SCOPES as readonly string[]).includes(x as string)
    ? (x as IntegralScope | "scene-adjacent")
    : "scene-adjacent";
}

/** Parse the LLM response into a ScopeDecision (lenient JSON, defensive). */
export function parseScopeDecision(text: string, result: IntegralResult): ScopeDecision {
  const fallback: ScopeDecision = {
    sufficientScope: "scene-adjacent",
    keepAnchors: result.seeds,
    keepDomains: result.domains.filter((d) => d.via === "direct").map((d) => d.name),
    reason: text.trim().slice(0, 200) || "no judge response; defaulting to full bundle",
    confidence: 0.3,
    answer: null,
  };
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return fallback;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return fallback;
  }
  const validIds = new Set<AnchorId>(result.anchors.map((a) => a.id));
  const keepAnchors = asStringArray(obj.keepAnchors).filter((a) =>
    validIds.has(a as AnchorId),
  ) as AnchorId[];
  const conf = typeof obj.confidence === "number" ? obj.confidence : Number(obj.confidence);
  return {
    sufficientScope: asScope(obj.sufficientScope),
    keepAnchors: keepAnchors.length > 0 ? keepAnchors : result.seeds,
    keepDomains: asStringArray(obj.keepDomains),
    reason: typeof obj.reason === "string" ? obj.reason : fallback.reason,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
    answer: typeof obj.answer === "string" && obj.answer.trim() ? obj.answer : null,
  };
}

/** Phase B: ask the injected LLM (Sonnet) to judge the sufficient scope. */
export async function judgeScope(
  query: IntegralQuery,
  result: IntegralResult,
  llm: LLMClient,
): Promise<ScopeDecision> {
  const prompt = assembleJudgePrompt(query, result);
  const response = await llm(prompt);
  return parseScopeDecision(response, result);
}
