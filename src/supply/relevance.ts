import { latinTokensForKatakana } from "./katakana-latin.js";
import type { EmbeddingClient } from "../spec/semantic.js";
import type { FunctionNode, SpecClause } from "../types.js";

export const RELEVANCE_VERSION = "relevance-v1";

export interface RelevanceOptions {
  topClauses?: number;
  topExemplars?: number;
  embedder?: EmbeddingClient;
}

const DEFAULT_TOP_CLAUSES = 12;
const DEFAULT_TOP_EXEMPLARS = 5;

export function rankSpecClauses(
  task: string,
  clauses: SpecClause[],
  opts: RelevanceOptions = {},
): SpecClause[] {
  const limit = opts.topClauses ?? DEFAULT_TOP_CLAUSES;
  return clauses
    .map((clause, index) => ({
      item: clause,
      index,
      score: relevanceScore(task, `${clause.heading} ${clause.text}`),
    }))
    .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id) || a.index - b.index)
    .slice(0, limit)
    .map((x) => x.item);
}

export function rankExemplars(
  task: string,
  functions: FunctionNode[],
  opts: RelevanceOptions = {},
): FunctionNode[] {
  const limit = opts.topExemplars ?? DEFAULT_TOP_EXEMPLARS;
  const candidates = functions.filter((fn) => fn.id !== null);
  const ranked = candidates
    .map((fn, index) => ({
      item: fn,
      index,
      score: relevanceScore(task, `${fn.name} ${fn.signature}`),
    }))
    .sort((a, b) => {
      const aLoc = locationKey(a.item);
      const bLoc = locationKey(b.item);
      return b.score - a.score || aLoc.localeCompare(bLoc) || a.index - b.index;
    });

  const hits = ranked.filter((x) => x.score > 0).slice(0, limit);
  if (hits.length > 0) return hits.map((x) => x.item);
  return candidates.slice(0, limit);
}

/**
 * Tokenize for relevance scoring.
 *
 * Latin text splits on camelCase + non-word characters. Japanese has no spaces,
 * so a run of kana/kanji arrives as ONE token ("切り絵のデモを実装する") that
 * matches nothing; it is additionally split into character BIGRAMS ("切り",
 * "り絵", "絵の", ...). Bigrams are the smallest unit that still carries
 * meaning: per-character tokens made every task overlap every domain (single
 * kana like を / する occur in almost any Japanese text), which inflated the
 * score of unrelated domains instead of ranking the related one first.
 *
 * Katakana loanwords additionally emit their latin spelling
 * (katakana-latin.ts), because a Japanese task says "デモ" where the domain
 * description says `demo`. The latin token joins the SAME set as every other
 * token, so it carries the same weight — nothing about the scoring changes,
 * only what the text is seen to contain.
 */
export function tokenizeRelevanceText(text: string): string[] {
  const normalized = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  const words = normalized.match(JAPANESE_OR_WORD_RUN) ?? [];
  const out: string[] = [];
  for (const word of words) {
    out.push(word);
    if (JAPANESE_RUN.test(word)) {
      out.push(...bigrams(word));
      out.push(...latinTokensForKatakana(word));
    }
  }
  return out;
}

const JAPANESE_OR_WORD_RUN = /[a-z0-9_]+|[\u3040-\u30ff\u3400-\u9fff]+/g;
const JAPANESE_RUN = /^[\u3040-\u30ff\u3400-\u9fff]+$/;

/**
 * Character bigrams of a Japanese run. Runs of one or two characters yield none
 * — the whole-word push above already emits exactly those tokens.
 */
function bigrams(word: string): string[] {
  if (word.length <= 2) return [];
  const out: string[] = [];
  for (let i = 0; i + 1 < word.length; i++) out.push(word.slice(i, i + 2));
  return out;
}

function relevanceScore(task: string, candidate: string): number {
  const taskTokens = tokenizeRelevanceText(task);
  if (taskTokens.length === 0) return 0;
  const taskSet = new Set(taskTokens);
  const candidateTokens = tokenizeRelevanceText(candidate);
  const candidateSet = new Set(candidateTokens);

  let matches = 0;
  for (const token of taskSet) {
    if (candidateSet.has(token)) matches++;
  }

  return matches / taskSet.size;
}

function locationKey(fn: FunctionNode): string {
  return `${fn.sourceRange.filePath}:${fn.sourceRange.start.line}:${fn.name}:${fn.id ?? ""}`;
}
