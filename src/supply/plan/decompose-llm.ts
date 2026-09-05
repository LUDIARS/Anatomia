/**
 * src/supply/plan/decompose-llm.ts — Step 2a: LLM decomposition (§3.2).
 *
 * The one judgement in the plan pipeline a deterministic rule cannot make:
 * given the task and the repos' DECLARED domains, which responsibilities does
 * the task split into, which domain owns each, which paths will be touched, and
 * is a domain missing entirely. The model sees only names/descriptions/paths —
 * no source — and answers with JSON that the rest of the pipeline enriches from
 * the analysis graph, so the deterministic facts stay deterministic.
 *
 * The LLM is reached through `claude -p` with a PINNED model (LUDIARS rule: no
 * ANTHROPIC_API_KEY, always `--model`). A missing CLI, a bad answer or an
 * overrun deadline THROWS; the caller (index.ts) falls back to the
 * deterministic decomposition and records why in the plan's notes — the
 * degradation is reported, never silent (RULE_CODE §7).
 *
 * SRP: prompt construction + response parsing. No enrichment, no fallback
 * policy (index.ts owns that).
 */

import { createClaudeCliLlm } from "../../providers/claude-cli-llm.js";
import type { LLMClient } from "../../domains/card.js";
import type { DecomposedItem, Decomposition } from "./decompose-fallback.js";
import type { PlanDomainCandidate, PlanUnresolved } from "./types.js";

/** Model the decomposition is pinned to (never inferred from the environment). */
export const PLAN_MODEL = "claude-opus-5";

/** Default wall-clock budget for one decomposition call. */
export const PLAN_LLM_TIMEOUT_MS = 60_000;

const PLAN_SYSTEM_PROMPT = [
  "You split a software task into DOMAIN-SIZED pieces for a code-architecture tool.",
  "You are given the task text and the domains the repositories declare (name, description, owned path patterns).",
  "Answer with ONE JSON object and nothing else. Do not add prose or a code fence.",
  "Never invent a repo id or a domain name that is not in the candidate list, except inside newDomain.",
  "Keep responsibility text in the same language as the task.",
].join(" ");

/** Options for {@link decomposeWithLlm}. */
export interface LlmDecomposeOptions {
  /** Pinned model id. Default {@link PLAN_MODEL}. */
  model?: string;
  /** `claude` executable. Default resolves on PATH. */
  bin?: string;
  /** Wall-clock budget in ms. Default {@link PLAN_LLM_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Injected client, so tests never spawn a process. */
  llm?: LLMClient;
}

/** Build the user prompt: the task plus every declared candidate. */
export function buildDecomposePrompt(task: string, candidates: PlanDomainCandidate[]): string {
  const lines: string[] = [];
  lines.push(`TASK: ${task}`);
  lines.push("");
  lines.push("CANDIDATE DOMAINS (repo / domain / implementors / description / owned paths):");
  for (const candidate of candidates) {
    lines.push(
      `- ${candidate.repo} / ${candidate.name} / ${candidate.implementors} impl` +
        `\n    description: ${candidate.description}` +
        `\n    paths: ${candidate.pathPatterns.join(", ") || "(none declared)"}`,
    );
  }
  lines.push("");
  lines.push("Answer with this JSON shape:");
  lines.push(
    JSON.stringify({
      items: [
        {
          repo: "<repo id from the list>",
          domain: "<domain name>",
          status: "existing | new",
          responsibility: "<what this piece is responsible for>",
          plannedPaths: ["<repo-relative path this piece will touch>"],
          neededTypes: ["<type or data definition this piece needs>"],
          newDomain: {
            name: "<only when status is new>",
            description: "<one line, reviewed by a human later>",
            membership: [{ pathPattern: "(^|/)src/<dir>/[^/]+$" }],
          },
        },
      ],
      unresolved: [{ repo: "<repo id>", subject: "<responsibility>", reason: "<why no domain fits>" }],
      questions: ["<question for the human>"],
    }),
  );
  lines.push("Omit newDomain for existing domains. Use empty arrays when there is nothing to report.");
  return lines.join("\n");
}

/**
 * Ask the model to split the task. Throws on an unusable answer so the caller
 * can fall back explicitly.
 */
export async function decomposeWithLlm(
  task: string,
  candidates: PlanDomainCandidate[],
  options: LlmDecomposeOptions = {},
): Promise<Decomposition> {
  const llm = options.llm
    ?? createClaudeCliLlm({
      model: options.model ?? PLAN_MODEL,
      bin: options.bin,
      systemPrompt: PLAN_SYSTEM_PROMPT,
      timeoutMs: options.timeoutMs ?? PLAN_LLM_TIMEOUT_MS,
    });
  const answer = await llm(buildDecomposePrompt(task, candidates));
  return parseDecomposition(answer, candidates);
}

/**
 * Parse the model's answer into a Decomposition, dropping pieces that name a
 * repo/domain outside the candidate list.
 *
 * A hallucinated domain is not a plan — it would send the author to a
 * declaration that does not exist — so it is dropped and reported as
 * `unresolved`, keeping the rest of the answer usable.
 */
export function parseDecomposition(
  answer: string,
  candidates: PlanDomainCandidate[],
): Decomposition {
  const parsed = parseJsonObject(answer);
  const known = new Set(candidates.map((c) => `${c.repo}\0${c.name}`));
  const repos = new Set(candidates.map((c) => c.repo));
  const items: DecomposedItem[] = [];
  const unresolved: PlanUnresolved[] = readUnresolved(parsed["unresolved"]);
  const questions: string[] = readStrings(parsed["questions"]);

  for (const raw of Array.isArray(parsed["items"]) ? parsed["items"] : []) {
    if (!isRecord(raw)) continue;
    const item = raw;
    const repo = typeof item["repo"] === "string" ? item["repo"] : "";
    const domain = typeof item["domain"] === "string" ? item["domain"] : "";
    const responsibility = typeof item["responsibility"] === "string" ? item["responsibility"] : "";
    if (!repo || !domain) continue;
    if (!repos.has(repo)) {
      unresolved.push({ repo, subject: responsibility || domain, reason: `未知のリポジトリ "${repo}" を指しています` });
      continue;
    }
    const status = item["status"] === "new" ? "new" : "existing";
    if (status === "existing" && !known.has(`${repo}\0${domain}`)) {
      unresolved.push({
        repo,
        subject: responsibility || domain,
        reason: `宣言されていないドメイン "${domain}" を既存として指しています`,
      });
      continue;
    }
    const newDomain = status === "new" ? readNewDomain(item["newDomain"], domain) : undefined;
    items.push({
      repo,
      domain,
      status,
      responsibility,
      plannedPaths: readStrings(item["plannedPaths"]),
      neededTypes: readStrings(item["neededTypes"]),
      ...(newDomain ? { newDomain } : {}),
    });
    if (status === "new") {
      questions.push(
        `[${repo}] 新規ドメイン "${domain}" の定義 (説明・membership) をレビューしてください。`,
      );
    }
  }

  if (items.length === 0 && unresolved.length === 0) {
    throw new Error("LLM decomposition returned no usable items");
  }
  return { items, unresolved, questions };
}

/** Parse the first `{...}` block of a possibly fenced answer. */
function parseJsonObject(answer: string): Record<string, unknown> {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`LLM decomposition answer has no JSON object: ${answer.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.slice(start, end + 1));
  } catch {
    throw new Error(`LLM decomposition answer is not valid JSON: ${answer.slice(0, 200)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LLM decomposition answer is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function readStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
}

function readUnresolved(value: unknown): PlanUnresolved[] {
  if (!Array.isArray(value)) return [];
  const out: PlanUnresolved[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const entry = raw;
    const subject = typeof entry["subject"] === "string" ? entry["subject"] : "";
    if (!subject) continue;
    out.push({
      repo: typeof entry["repo"] === "string" ? entry["repo"] : "",
      subject,
      reason: typeof entry["reason"] === "string" ? entry["reason"] : "理由の記載なし",
    });
  }
  return out;
}

/** A `new` item without a usable declaration proposal still plans; membership may be empty. */
function readNewDomain(
  value: unknown,
  domain: string,
): { name: string; description: string; membership: { pathPattern: string }[] } {
  const raw = isRecord(value) ? value : {};
  const membership = Array.isArray(raw["membership"])
    ? raw["membership"]
        .map((m) => (m as Record<string, unknown>)?.["pathPattern"])
        .filter((p): p is string => typeof p === "string" && p !== "")
        .map((pathPattern) => ({ pathPattern }))
    : [];
  return {
    name: typeof raw["name"] === "string" && raw["name"] !== "" ? raw["name"] : domain,
    description: typeof raw["description"] === "string" ? raw["description"] : "",
    membership,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
