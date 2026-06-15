/**
 * T20 — Domain-card generation with content-keyed caching.
 *
 * A DomainCard is the LLM-distilled canonical summary of a domain (DESIGN
 * §4.4): what it is, its rules, key anchors, spec refs, complexity. It is the
 * unit of caching + delivery.
 *
 * Caching is content-keyed: cacheKey = merkleHash(sorted implementor function
 * hashes). Because AnchorId IS the normalized function hash, the implementor
 * anchors are exactly those content hashes. On a cache hit the LLM is NOT
 * called; only a cache miss invokes it (verified in card.test.ts).
 *
 * SRP: this file owns prompt assembly + caching + response parsing. The LLM is
 * an injected interface (LLMClient) — no real API calls, no hardcoded client.
 */

import { createHash } from "node:crypto";
import type { AnchorId } from "../types.js";
import type { CodeGraphQuery } from "../graph/query.js";
import type { DetectionResult } from "./detect.js";

/** Injected LLM interface: prompt -> completion text. Never hardcoded. */
export type LLMClient = (prompt: string) => Promise<string>;

export interface DomainCard {
  domain: string;
  summary: string;
  rules: string[];
  keyAnchors: AnchorId[];
  specRefs: string[];
  complexity: "low" | "medium" | "high";
  /** Content key = merkleHash of implementor function hashes. */
  cacheKey: string;
}

/** In-memory content-addressed card cache. */
export type CardCache = Map<string, DomainCard>;

/** Create an empty in-memory card cache. */
export function createCardCache(): CardCache {
  return new Map<string, DomainCard>();
}

/**
 * Content key over the implementor anchors (= function content hashes).
 * Sorted so the key is order-independent; SHA-256 hex (matches DAG hashing).
 */
export function merkleHash(anchors: AnchorId[]): string {
  const sorted = [...anchors].sort();
  return createHash("sha256").update(sorted.join("\n"), "utf8").digest("hex");
}

/**
 * Assemble the LLM prompt for a domain card from the detection result.
 * Deterministic (stable ordering) so identical inputs produce identical prompts.
 */
export async function assemblePrompt(
  domain: string,
  result: DetectionResult,
  graph: CodeGraphQuery,
): Promise<string> {
  const implementors = [...result.implementors].sort();
  const lines: string[] = [];
  lines.push(`Domain: ${domain}`);
  lines.push(`Implementing functions (${implementors.length}):`);
  for (const id of implementors) {
    const node = await graph.getNode(id);
    const name = node ? node.name : "<unknown>";
    const loc = node ? `${node.sourceRange.filePath}:${node.sourceRange.start.line}` : "";
    lines.push(`  - ${name} [anchor=${id}]${loc ? " @ " + loc : ""}`);
  }
  lines.push(`Violations (${result.violations.length}):`);
  for (const v of result.violations) {
    lines.push(`  - [${v.severity}] ${v.ruleId}: ${v.evidence}`);
  }
  lines.push(`Conforms: ${result.conforms}`);
  lines.push("");
  lines.push(
    "Return a JSON object with fields: summary (string), rules (string[]), " +
      "specRefs (string[]), complexity ('low'|'medium'|'high').",
  );
  return lines.join("\n");
}

/** Parse the LLM response into the structured card fields (lenient JSON). */
function parseResponse(text: string): {
  summary: string;
  rules: string[];
  specRefs: string[];
  complexity: "low" | "medium" | "high";
} {
  const fallback = {
    summary: text.trim().slice(0, 280),
    rules: [] as string[],
    specRefs: [] as string[],
    complexity: "medium" as const,
  };
  // Extract the first {...} block to tolerate prose around the JSON.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return fallback;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const complexity =
      obj.complexity === "low" || obj.complexity === "high" ? obj.complexity : "medium";
    return {
      summary: typeof obj.summary === "string" ? obj.summary : fallback.summary,
      rules: Array.isArray(obj.rules) ? obj.rules.map(String) : [],
      specRefs: Array.isArray(obj.specRefs) ? obj.specRefs.map(String) : [],
      complexity,
    };
  } catch {
    return fallback;
  }
}

/**
 * Generate (or fetch from cache) a domain card.
 *
 * Content-keyed cache: cacheKey = merkleHash(implementor anchors). On a cache
 * HIT the cached card is returned WITHOUT calling `llm`. Only a MISS calls
 * `llm`, then stores the result.
 */
export async function generateCard(
  domain: string,
  result: DetectionResult,
  graph: CodeGraphQuery,
  llm: LLMClient,
  cache?: CardCache,
): Promise<DomainCard> {
  const cacheKey = merkleHash(result.implementors);

  if (cache) {
    const hit = cache.get(cacheKey);
    if (hit) return hit; // cache hit: do NOT call llm
  }

  const prompt = await assemblePrompt(domain, result, graph);
  const response = await llm(prompt); // cache miss: call llm exactly once
  const parsed = parseResponse(response);

  const card: DomainCard = {
    domain,
    summary: parsed.summary,
    rules: parsed.rules,
    keyAnchors: [...result.implementors].sort(),
    specRefs: parsed.specRefs,
    complexity: parsed.complexity,
    cacheKey,
  };

  if (cache) cache.set(cacheKey, card);
  return card;
}
