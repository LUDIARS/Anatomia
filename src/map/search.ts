/**
 * src/map/search.ts — Rank the domain map against a free-text instruction.
 *
 * The query is a person's own sentence (「トランポリンカウンターで連続跳躍を数える」),
 * not a keyword list, so ranking combines two signals:
 *
 *   1. an ALIAS hit — the normalised name of a record appears verbatim inside the
 *      normalised query. That is an identity, and it outranks everything.
 *   2. TOKEN overlap — identifier tokens and Japanese bigrams against the
 *      inverted index's field-weighted postings.
 *
 * No LLM, no network: a search is a couple of map lookups over an index that is
 * already in memory (design §12.3, "検索は高速 (ミリ秒級、LLM 不要)").
 *
 * SRP: query → ranked hits. Index construction is inverted-index.ts.
 */
// @implements SPEC-domain-map

import {
  normalizeAlias,
  queryBigramPairs,
  queryTokens,
} from "./aliases.js";
import { phraseWeight, type DomainMapIndex } from "./inverted-index.js";
import type { DomainMapHit } from "./types.js";

/** Default result count. */
export const DEFAULT_SEARCH_LIMIT = 8;

/** How much an exact alias hit is worth relative to token overlap. */
const ALIAS_WEIGHT = 12;

/** Alias keys shorter than this are too generic to treat as an identity. */
const MIN_ALIAS_LENGTH = 3;

/**
 * Below this a hit is noise, not an answer.
 *
 * Japanese bigrams make almost any two sentences overlap a little: 「量子暗号の鍵
 * 配送を実装する」 shares 「する」 with half the index. One stray bigram of a long
 * query scores a fraction of a hit on a record's NAME, so the cut sits between
 * them and the zero-hit case stays a real zero — which is what `plan` turns into
 * its 「索引に無い」 question.
 */
const MIN_SCORE = 0.3;

/**
 * Value of one PHRASE link, in token units.
 *
 * Two adjacent query bigrams that hit the same record are evidence that the
 * record contains the three-character phrase they come from, not two unrelated
 * syllables. One extra token unit per link makes a k-bigram run worth 2k-1
 * units instead of k: 「切り絵」 outweighs 「デモ」, which is the whole point, while
 * the growth stays gentle enough that a long shared sentence cannot run away
 * with the ranking.
 */
const PHRASE_LINK = 1;


/** Kind precedence for equal scores — a person names content before layers. */
const KIND_ORDER = ["content", "core-domain", "spec", "scene", "service", "program-domain"];

/** Options for {@link searchDomainMap}. */
export interface SearchDomainMapOptions {
  limit?: number;
  /** Restrict to these project ids. Empty → every project in the index. */
  projects?: string[];
}

/** Rank `query` against the index; best first, at most `limit` hits. */
export function searchDomainMap(
  index: DomainMapIndex,
  query: string,
  options: SearchDomainMapOptions = {},
): DomainMapHit[] {
  const trimmed = query.trim();
  if (trimmed === "" || index.records.length === 0) return [];

  const requestedLimit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  if (!Number.isFinite(requestedLimit) || requestedLimit <= 0) return [];
  const limit = Math.trunc(requestedLimit);
  const wanted = new Set(options.projects ?? []);
  const scores = new Map<number, { score: number; matched: Set<string> }>();

  const normalizedQuery = normalizeAlias(trimmed);
  for (const [alias, records] of index.aliasExact) {
    if (alias.length < MIN_ALIAS_LENGTH || !normalizedQuery.includes(alias)) continue;
    // Longer aliases are more specific: 「とらんぽりんかうんた」 says more about the
    // instruction than 「かうんた」 does, and must win when both are present.
    for (const record of records) bump(scores, record, ALIAS_WEIGHT * alias.length, alias);
  }

  const tokens = queryTokens(trimmed);
  const total = index.records.length;
  if (tokens.length > 0) {
    const share = 1 / tokens.length;
    for (const token of new Set(tokens)) {
      const postings = index.postings.get(token) ?? [];
      // Inverse document frequency. Japanese instructions are full of bigrams
      // that occur everywhere (「実装」「する」「デモ」), and without this a long
      // document title that happens to contain 「実装スペック」 outscores the
      // domain the task is actually about. A token in almost every record
      // contributes almost nothing; a rare one carries the hit.
      const idf = idfOf(postings.length, total);
      for (const posting of postings) {
        bump(scores, posting.record, posting.weight * idf * share, token);
      }
    }
    scorePhrases(index, trimmed, share, total, scores);
  }

  const hits: DomainMapHit[] = [];
  for (const [at, entry] of scores) {
    const record = index.records[at]!;
    if (wanted.size > 0 && !wanted.has(record.project)) continue;
    if (entry.score < MIN_SCORE) continue;
    hits.push({ ...record, score: round(entry.score), matched: [...entry.matched].sort() });
  }
  return hits.sort(byScore).slice(0, limit);
}

/**
 * Reward records that answer a whole PHRASE, not two loose syllables.
 *
 * A record must both carry both halves of an adjacent bigram pair and contain
 * the reconstructed phrase contiguously in one field. The latter check prevents
 * unrelated fields from manufacturing a phrase that the record never says.
 * The pair is worth the weaker field and the rarer token, so a common bigram
 * sitting next to a rare one cannot buy a hit.
 */
function scorePhrases(
  index: DomainMapIndex,
  query: string,
  share: number,
  total: number,
  scores: Map<number, { score: number; matched: Set<string> }>,
): void {
  for (const [first, second] of queryBigramPairs(query)) {
    const left = index.postings.get(first);
    const right = index.postings.get(second);
    if (!left || !right) continue;
    const idf = Math.min(idfOf(left.length, total), idfOf(right.length, total));
    const weights = new Map(right.map((posting) => [posting.record, posting.weight]));
    const phrase = `${first}${second.slice(1)}`;
    for (const posting of left) {
      const other = weights.get(posting.record);
      if (other === undefined) continue;
      const fieldWeight = phraseWeight(index.records[posting.record]!, phrase);
      if (fieldWeight === 0) continue;
      const weight = Math.min(posting.weight, other, fieldWeight);
      bump(scores, posting.record, weight * idf * share * PHRASE_LINK, phrase);
    }
  }
}

/** Inverse document frequency of a token that occurs in `hits` of `total` records. */
function idfOf(hits: number, total: number): number {
  return Math.log(1 + total / Math.max(hits, 1));
}

function bump(
  scores: Map<number, { score: number; matched: Set<string> }>,
  record: number,
  amount: number,
  matched: string,
): void {
  const entry = scores.get(record);
  if (entry) {
    entry.score += amount;
    entry.matched.add(matched);
    return;
  }
  scores.set(record, { score: amount, matched: new Set([matched]) });
}

function byScore(a: DomainMapHit, b: DomainMapHit): number {
  return (
    b.score - a.score
    || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    || a.project.localeCompare(b.project)
    || a.name.localeCompare(b.name)
  );
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
