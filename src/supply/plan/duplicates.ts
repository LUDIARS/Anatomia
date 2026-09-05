/**
 * src/supply/plan/duplicates.ts — Step 4: "does this already exist?" (deterministic).
 *
 * The third step of the design's loop (ドメイン定義 → データ定義や重複確認 → 書く).
 * Each piece's responsibility text and needed types are tokenized with the same
 * tokenizer the detector uses (so a Japanese responsibility is compared on
 * bigrams, not as one opaque string) and matched against every analysed type
 * name, function name and file basename in the repo.
 *
 * This is a NAME-level search on purpose: it answers "something with this
 * vocabulary already exists here, look before you add another" before any code
 * is written. The structural, post-hoc check stays with the `duplication`
 * verify gate, which compares real implementations.
 *
 * SRP: similarity search over the analysed symbol names of one repo.
 */

import { tokenizeRelevanceText } from "../relevance.js";
import { repoRelative, type PlanRepo } from "./collect.js";
import type { PlanDuplicate } from "./types.js";

/** Below this share of the query's tokens a hit is noise, not a near-duplicate. */
const MIN_SCORE = 0.34;

/** How many candidates one plan item reports. */
const MAX_DUPLICATES = 5;

/** One searchable symbol of a repo. */
interface SymbolEntry {
  name: string;
  path: string;
  tokens: Set<string>;
}

/**
 * Existing symbols whose names overlap the piece's vocabulary.
 *
 * `ownFiles` (the target domain's own files) are excluded: a domain's existing
 * members are already reported as `dataDefs`, and repeating them as
 * "duplicates" would tell the author their own domain duplicates itself.
 */
export function findDuplicates(
  repo: PlanRepo,
  query: { responsibility: string; neededTypes: string[] },
  ownFiles: ReadonlySet<string>,
): PlanDuplicate[] {
  const queryTokens = new Set(
    tokenizeRelevanceText([query.responsibility, ...query.neededTypes].join(" ")),
  );
  if (queryTokens.size === 0) return [];

  const scored: PlanDuplicate[] = [];
  for (const entry of symbolsOf(repo)) {
    if (ownFiles.has(entry.path)) continue;
    let matches = 0;
    for (const token of queryTokens) {
      if (entry.tokens.has(token)) matches++;
    }
    const score = matches / queryTokens.size;
    if (score < MIN_SCORE) continue;
    scored.push({ name: entry.name, path: entry.path, score: round(score) });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
    .slice(0, MAX_DUPLICATES);
}

/** Type names, function names and file basenames of a repo, tokenized once. */
function symbolsOf(repo: PlanRepo): SymbolEntry[] {
  let cached = symbolCache.get(repo);
  if (cached) return cached;
  const out: SymbolEntry[] = [];
  for (const file of repo.ctx.files) {
    const rel = repoRelative(repo.repoPath, file.path);
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    out.push({ name: base, path: rel, tokens: new Set(tokenizeRelevanceText(base)) });
    for (const type of file.types ?? []) {
      out.push({ name: type.name, path: rel, tokens: new Set(tokenizeRelevanceText(type.name)) });
    }
  }
  for (const fn of repo.ctx.functions) {
    const rel = repoRelative(repo.repoPath, fn.sourceRange.filePath);
    out.push({ name: fn.name, path: rel, tokens: new Set(tokenizeRelevanceText(fn.name)) });
  }
  cached = out;
  symbolCache.set(repo, cached);
  return cached;
}

/**
 * Tokenizing every symbol of a repo is the costly half of this step, and a plan
 * runs it once per item. The set depends only on the analysed repo, so memoize
 * per PlanRepo — a re-analysis produces a new object and a fresh index.
 */
const symbolCache = new WeakMap<PlanRepo, SymbolEntry[]>();

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
