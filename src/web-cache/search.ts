/**
 * src/web-cache/search.ts — LLM search over the prepared corpus.
 *
 * Mirrors the integral search's LLM use: free text in, an LLM (Haiku) out. Two
 * calls: (1) parse the query into keywords + target kinds, (2) rerank the
 * keyword-prefiltered candidates and explain each hit. The corpus is the
 * prepared cache (search-corpus.ts); a query never touches analyze().
 *
 * Fail-fast (RULE_CODE §7, memory feedback_no_silent_fallback): this function
 * REQUIRES a real LLM. The route refuses to call it when only the stub LLM is
 * configured — it does NOT silently degrade to substring search. The internal
 * fallbacks here are LLM-OUTPUT resilience (a malformed completion falls back to
 * the deterministic keyword ranking), never a missing-config fallback.
 *
 * SRP: corpus + query + llm → ranked results. No HTTP, no persistence.
 */

import type { LLMClient } from "../domains/card.js";
import { callLlmJson, asArray } from "../domains/retune/llm.js";
import type { SearchCorpus, SearchEntry, SearchEntryKind } from "./types.js";

/** Max candidates handed to the rerank LLM call. */
const PREFILTER_LIMIT = 60;
/** Max results returned. */
const RESULT_LIMIT = 25;

/** Parsed query intent. */
export interface QueryIntent {
  keywords: string[];
  kinds: SearchEntryKind[];
  intent: string;
}

/** One ranked search hit. */
export interface SearchResult {
  kind: SearchEntryKind;
  ref: string;
  title: string;
  file?: string;
  line?: number;
  domains?: string[];
  module?: string;
  /** One-line reason the LLM (or keyword fallback) surfaced this. */
  reason: string;
}

/** Outcome returned to the panel. */
export interface SearchOutcome {
  query: string;
  intent: string;
  results: SearchResult[];
}

const KINDS = new Set<SearchEntryKind>(["function", "domain", "module", "spec"]);

/** Lowercased ascii word tokens of a string (>=2 chars). */
function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length >= 2);
}

/** Searchable text blob for an entry. */
function blob(e: SearchEntry): string {
  return [e.title, e.text ?? "", e.file ?? "", e.module ?? "", (e.domains ?? []).join(" ")]
    .join(" ")
    .toLowerCase();
}

/**
 * Deterministic keyword prefilter. A title hit weighs more than a body hit. When
 * `kinds` is non-empty, only those kinds are considered. Pure + exported so the
 * ranking is unit-testable without an LLM.
 */
export function prefilter(
  entries: SearchEntry[],
  keywords: string[],
  kinds: SearchEntryKind[] = [],
  limit: number = PREFILTER_LIMIT,
): SearchEntry[] {
  const kws = keywords.map((k) => k.toLowerCase()).filter((k) => k.length >= 2);
  if (kws.length === 0) return [];
  const kindSet = new Set(kinds);
  const scored: { e: SearchEntry; score: number }[] = [];
  for (const e of entries) {
    if (kindSet.size > 0 && !kindSet.has(e.kind)) continue;
    const title = e.title.toLowerCase();
    const body = blob(e);
    let score = 0;
    for (const kw of kws) {
      if (title.includes(kw)) score += 3;
      else if (body.includes(kw)) score += 1;
    }
    if (score > 0) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.e.title < b.e.title ? -1 : 1));
  return scored.slice(0, limit).map((s) => s.e);
}

/** Ask the LLM to parse the free-text query into keywords + target kinds. */
async function parseQuery(llm: LLMClient, query: string): Promise<QueryIntent> {
  const prompt =
    `You convert a code-search query into a JSON object. The codebase index has ` +
    `entries of kind: function, domain, module, spec.\n` +
    `Return ONLY JSON: {"keywords": string[], "kinds": string[], "intent": string}.\n` +
    `- keywords: lowercase identifier-like terms likely to appear in code/spec ` +
    `(include English equivalents if the query is not English).\n` +
    `- kinds: subset of [function,domain,module,spec] the user likely wants, or [] for any.\n` +
    `- intent: one short sentence restating the goal.\n\n` +
    `Query: ${query}`;
  try {
    const parsed = await callLlmJson<Partial<QueryIntent>>(llm, prompt);
    const keywords = asArray<string>(parsed.keywords).filter((k) => typeof k === "string");
    const kinds = asArray<string>(parsed.kinds).filter((k): k is SearchEntryKind =>
      KINDS.has(k as SearchEntryKind),
    );
    const intent = typeof parsed.intent === "string" ? parsed.intent : "";
    // Always seed with the raw query words so a thin LLM parse still prefilters.
    const merged = [...new Set([...keywords, ...words(query)])];
    return { keywords: merged.length ? merged : words(query), kinds, intent };
  } catch {
    return { keywords: words(query), kinds: [], intent: "" };
  }
}

/** Ask the LLM to rerank candidates and explain each hit. */
async function rerank(
  llm: LLMClient,
  query: string,
  candidates: SearchEntry[],
): Promise<SearchResult[]> {
  const byRef = new Map(candidates.map((e) => [e.ref, e]));
  const lines = candidates
    .map((e, i) => `${i}\t${e.kind}\t${e.ref}\t${e.title}\t${(e.text ?? e.file ?? "").slice(0, 120)}`)
    .join("\n");
  const prompt =
    `Rank these code-index candidates by relevance to the query and explain each.\n` +
    `Return ONLY JSON: an array of {"ref": string, "reason": string}, best first, ` +
    `at most ${RESULT_LIMIT}, dropping irrelevant ones.\n\n` +
    `Query: ${query}\n\nCandidates (index\\tkind\\tref\\ttitle\\tsnippet):\n${lines}`;
  try {
    const ranked = await callLlmJson<{ ref?: string; reason?: string }[]>(llm, prompt);
    const out: SearchResult[] = [];
    for (const r of asArray<{ ref?: string; reason?: string }>(ranked)) {
      const e = r && typeof r.ref === "string" ? byRef.get(r.ref) : undefined;
      if (!e) continue;
      out.push(toResult(e, typeof r.reason === "string" ? r.reason : ""));
      if (out.length >= RESULT_LIMIT) break;
    }
    if (out.length > 0) return out;
  } catch {
    // fall through to deterministic ordering
  }
  return candidates.slice(0, RESULT_LIMIT).map((e) => toResult(e, "keyword match"));
}

function toResult(e: SearchEntry, reason: string): SearchResult {
  return {
    kind: e.kind,
    ref: e.ref,
    title: e.title,
    file: e.file,
    line: e.line,
    domains: e.domains,
    module: e.module,
    reason,
  };
}

/**
 * Run an LLM search over a prepared corpus. Requires a real LLM (caller guards
 * the stub case and fails fast).
 */
export async function searchCorpus(
  corpus: SearchCorpus,
  query: string,
  llm: LLMClient,
): Promise<SearchOutcome> {
  const q = query.trim();
  if (!q) return { query, intent: "", results: [] };

  const parsed = await parseQuery(llm, q);
  let candidates = prefilter(corpus.entries, parsed.keywords, parsed.kinds);
  if (candidates.length === 0 && parsed.kinds.length > 0) {
    // Kinds filter was too tight — retry across all kinds.
    candidates = prefilter(corpus.entries, parsed.keywords, []);
  }
  if (candidates.length === 0) return { query, intent: parsed.intent, results: [] };

  const results = await rerank(llm, q, candidates);
  return { query, intent: parsed.intent, results };
}
