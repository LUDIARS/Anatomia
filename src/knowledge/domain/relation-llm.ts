/**
 * src/knowledge/domain/relation-llm.ts — Drafting the context-map relations
 * (design §7.2 A-8, draft half).
 *
 * "These two core domains have code depending on each other" is deterministic
 * (relation-candidates.ts). "This is a shared kernel, that one is a one-way
 * dependency" is a judgement, so the LLM writes the FIRST draft and a human
 * approves it — the same shape as Gate A for domain definitions. Nothing this
 * file returns is authoritative: every proposal carries `draft: true` and is
 * only written to the knowledge log through relation-approval.ts.
 *
 * The model is reached through `claude -p` with a PINNED model (LUDIARS rule:
 * no ANTHROPIC_API_KEY, always `--model`), exactly as the plan decomposition
 * does. A missing CLI or an unusable answer THROWS; the caller decides whether
 * to fall back to the deterministic draft below and say so.
 *
 * SRP: prompt construction + answer parsing + the deterministic draft. No
 * writing, no approval.
 *
 * @spec コアドメイン間の関係辺（コンテキストマップ、A-8）
 */

import { createClaudeCliLlm } from "../../providers/claude-cli-llm.js";
import type { LLMClient } from "../../domains/card.js";
import {
  isDomainRelationKind,
  type DomainRelationCandidate,
  type DomainRelationProposal,
} from "./relation-types.js";

/** Model the relation draft is pinned to (never inferred from the environment). */
export const RELATION_MODEL = "claude-opus-5";

/** Default wall-clock budget for one draft call. */
export const RELATION_LLM_TIMEOUT_MS = 60_000;

const RELATION_SYSTEM_PROMPT = [
  "You label DDD context-map relations between core domains of one codebase.",
  "You are given candidate domain pairs with the code-dependency weight behind each pair.",
  "Answer with ONE JSON object and nothing else. Do not add prose or a code fence.",
  "Never invent a domain id that is not in the candidate list.",
  "Your answer is a DRAFT reviewed by a human; say what the evidence supports, not more.",
].join(" ");

/** Options for {@link draftDomainRelations}. */
export interface RelationDraftOptions {
  model?: string;
  bin?: string;
  timeoutMs?: number;
  /** Injected client, so tests never spawn a process. */
  llm?: LLMClient;
}

/** Build the draft prompt from the deterministic candidates. */
export function buildRelationDraftPrompt(
  candidates: readonly DomainRelationCandidate[],
  domainPurposes: ReadonlyMap<string, string> = new Map(),
): string {
  const lines: string[] = [];
  lines.push("CANDIDATE DOMAIN PAIRS (from -> to / dependency weight / program-domain evidence):");
  for (const candidate of candidates) {
    lines.push(
      `- ${candidate.fromDomainId} -> ${candidate.toDomainId} / weight ${candidate.weight}`
      + `\n    from purpose: ${domainPurposes.get(candidate.fromDomainId) ?? "(unknown)"}`
      + `\n    to purpose: ${domainPurposes.get(candidate.toDomainId) ?? "(unknown)"}`
      + `\n    program domains: ${candidate.programDomainPairs.map((pair) => `${pair.from}->${pair.to}(${pair.weight})`).join(", ")}`,
    );
  }
  lines.push("");
  lines.push("relation must be one of: depends-on | collaborates | shared-kernel");
  lines.push("Answer with this JSON shape:");
  lines.push(JSON.stringify({
    relations: [{
      from: "<domain id from the list>",
      to: "<domain id from the list>",
      relation: "depends-on",
      rationale: "<one line explaining the relation, reviewed by a human>",
    }],
  }));
  return lines.join("\n");
}

/** Ask the model to label the candidates. Throws on an unusable answer. */
export async function draftDomainRelations(
  candidates: readonly DomainRelationCandidate[],
  domainPurposes: ReadonlyMap<string, string> = new Map(),
  options: RelationDraftOptions = {},
): Promise<DomainRelationProposal[]> {
  if (candidates.length === 0) return [];
  const llm = options.llm
    ?? createClaudeCliLlm({
      model: options.model ?? RELATION_MODEL,
      bin: options.bin,
      systemPrompt: RELATION_SYSTEM_PROMPT,
      timeoutMs: options.timeoutMs ?? RELATION_LLM_TIMEOUT_MS,
    });
  return parseRelationDraft(await llm(buildRelationDraftPrompt(candidates, domainPurposes)), candidates);
}

/**
 * Parse the model's answer into proposals, dropping any pair the deterministic
 * aggregation did not produce. A hallucinated pair has no evidence behind it,
 * so it cannot be reviewed — it is dropped rather than shown as a candidate.
 */
export function parseRelationDraft(
  answer: string,
  candidates: readonly DomainRelationCandidate[],
): DomainRelationProposal[] {
  const parsed = parseJsonObject(answer);
  const byPair = new Map<string, DomainRelationCandidate>(
    candidates.map((c) => [`${c.fromDomainId}\0${c.toDomainId}`, c] as const),
  );
  const out: DomainRelationProposal[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(parsed["relations"]) ? parsed["relations"] : []) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const from = typeof entry["from"] === "string" ? entry["from"] : "";
    const to = typeof entry["to"] === "string" ? entry["to"] : "";
    const key = `${from}\0${to}`;
    const candidate = byPair.get(key);
    if (!candidate || seen.has(key)) continue;
    if (!isDomainRelationKind(entry["relation"])) continue;
    seen.add(key);
    out.push({
      proposalId: `domain-relation/${from}->${to}`,
      fromDomainId: from,
      toDomainId: to,
      relation: entry["relation"],
      rationale: typeof entry["rationale"] === "string" ? entry["rationale"] : "",
      candidate,
      draft: true,
    });
  }
  if (out.length === 0) throw new Error("LLM relation draft returned no usable relations");
  return out.sort((left, right) =>
    left.fromDomainId.localeCompare(right.fromDomainId)
    || left.toDomainId.localeCompare(right.toDomainId));
}

/**
 * The draft to use when no LLM is available: every candidate becomes a
 * `depends-on` proposal whose rationale says it was NOT judged. It is weaker
 * than the LLM draft and says so, rather than presenting a guess as a reading.
 */
export function draftDomainRelationsDeterministically(
  candidates: readonly DomainRelationCandidate[],
): DomainRelationProposal[] {
  return candidates.map((candidate) => ({
    proposalId: `domain-relation/${candidate.fromDomainId}->${candidate.toDomainId}`,
    fromDomainId: candidate.fromDomainId,
    toDomainId: candidate.toDomainId,
    relation: "depends-on" as const,
    rationale: `コード依存 ${candidate.weight} 件から機械的に起こした下書き (関係種別は未判定 — 人間が決める)`,
    candidate,
    draft: true as const,
  }));
}

/** Parse the first `{...}` block of a possibly fenced answer. */
function parseJsonObject(answer: string): Record<string, unknown> {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("LLM relation draft has no JSON object");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(answer.slice(start, end + 1)); }
  catch { throw new Error("LLM relation draft is not valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LLM relation draft is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}
