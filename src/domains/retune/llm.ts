/**
 * src/domains/retune/llm.ts — JSON-returning LLM helper for the re-tune steps.
 *
 * The steps ask the LLM for SHORT structured JSON (taxonomy fragments), never
 * long Markdown bodies (memory: feedback_llm_long_markdown_no_json). This helper
 * calls the injected LLMClient, strips an optional ```json fence, and parses.
 *
 * Fail-fast (RULE_CODE §7): a configuration deficiency already throws in
 * resolveProviders; here a malformed completion (un-parseable after fence
 * stripping) is a hard error — never a silent empty default.
 *
 * SRP: prompt → parsed JSON value. No prompt construction (prompts.ts), no
 * step logic (steps.ts).
 */

import type { LLMClient } from "../card.js";

/** Strip a leading/trailing Markdown code fence if the model wrapped its JSON. */
export function stripFence(text: string): string {
  const t = text.trim();
  const fence = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fence) return fence[1]!.trim();
  return t;
}

/**
 * Extract the first balanced JSON object/array from arbitrary text — robust to a
 * model that prepends prose ("Here is the JSON:") before the payload.
 */
export function extractJson(text: string): string {
  const stripped = stripFence(text);
  const firstObj = stripped.indexOf("{");
  const firstArr = stripped.indexOf("[");
  const starts = [firstObj, firstArr].filter((i) => i >= 0);
  if (starts.length === 0) return stripped;
  const start = Math.min(...starts);
  const open = stripped[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < stripped.length; i++) {
    const c = stripped[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return stripped.slice(start, i + 1);
    }
  }
  return stripped.slice(start);
}

/** Call the LLM and parse its completion as JSON. Throws on un-parseable output. */
export async function callLlmJson<T = unknown>(llm: LLMClient, prompt: string): Promise<T> {
  const raw = await llm(prompt);
  const json = extractJson(raw);
  try {
    return JSON.parse(json) as T;
  } catch (err) {
    throw new Error(
      `retune LLM returned non-JSON output: ${String(err)}\n--- raw (first 500 chars) ---\n${raw.slice(0, 500)}`,
    );
  }
}

/** Coerce a value that should be an array (LLMs sometimes return a bare object). */
export function asArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v === null || v === undefined) return [];
  return [v as T];
}
