/**
 * src/map/inverted-index.ts — The in-memory index every project is bundled into.
 *
 * Search must answer in milliseconds with no LLM (design §12.3), so the records
 * of every registered project are folded ONCE into an inverted index:
 *
 *   postings    token → the records that contain it, with a per-field weight
 *   aliasExact  normalised alias key → the records that name it exactly
 *
 * The two are separate because they answer different questions. Postings give
 * graded relevance ("this looks related"); an exact alias hit is an identity
 * ("this IS the thing you named"), and it must outrank every graded match —
 * that is what makes 「トランポリンカウンターで〇〇」 land on the trampoline
 * counter rather than on whichever domain shares the most bigrams with it.
 *
 * SRP: index construction only. Query handling is search.ts.
 */
// @implements SPEC-domain-map

import { aliasKeys, indexTokens, katakanaToHiragana, pathTokens } from "./aliases.js";
import type { DomainMapRecord, ProjectDomainMap } from "./types.js";

/** One token occurrence: which record, and how much this field is worth. */
export interface Posting {
  record: number;
  weight: number;
}

/** The bundled index over every project's records. */
export interface DomainMapIndex {
  records: DomainMapRecord[];
  postings: Map<string, Posting[]>;
  aliasExact: Map<string, number[]>;
  /** Project ids covered, in bundle order. */
  projects: string[];
}

/**
 * Field weights.
 *
 * The name is what a person types; the core domain name is the answer they want;
 * paths corroborate.
 *
 * The description is NOT mere corroboration, which is what a weight of 1 made of
 * it. A `core-domain` record's name is a romaji identifier (`kirie-transform`)
 * that a Japanese instruction never contains, so its description — the design's
 * 「日本語のまま」 field (§12.2) — is the ONLY text such a record can be found by.
 * At a sixth of the name weight, a domain merely NAMED `demo` beat the domain
 * whose description is about 切り絵 for 「切り絵のデモを実装する」. Half the name
 * weight keeps the original property (a passing mention still loses to a name
 * that IS the word) without making the only Japanese field nearly worthless.
 */
const WEIGHT_NAME = 6;
const WEIGHT_DOMAIN = 4;
const WEIGHT_PATH = 2;
const WEIGHT_DESCRIPTION = 3;

/** Weight of the strongest single field that contains `phrase` contiguously. */
export function phraseWeight(record: DomainMapRecord, phrase: string): number {
  const contains = (text: string): boolean =>
    katakanaToHiragana(text.normalize("NFKC")).includes(phrase);
  return Math.max(
    contains(record.name) ? WEIGHT_NAME : 0,
    contains(record.coreDomain ?? "") ? WEIGHT_DOMAIN : 0,
    contains(record.description) ? WEIGHT_DESCRIPTION : 0,
    contains(record.spec ?? "") || record.paths.some(contains) ? WEIGHT_PATH : 0,
  );
}

/** Fold one project's records into an existing index (mutates `index`). */
export function addProjectToIndex(index: DomainMapIndex, map: ProjectDomainMap): void {
  index.projects.push(map.project);
  for (const record of map.records) {
    const at = index.records.length;
    index.records.push(record);
    for (const alias of record.aliases) {
      index.aliasExact.set(alias, [...(index.aliasExact.get(alias) ?? []), at]);
    }
    add(index, at, indexTokens(record.name), WEIGHT_NAME);
    add(index, at, indexTokens(record.coreDomain ?? ""), WEIGHT_DOMAIN);
    add(index, at, aliasKeys(record.name), WEIGHT_NAME);
    for (const path of record.paths) add(index, at, pathTokens(path), WEIGHT_PATH);
    if (record.spec) add(index, at, pathTokens(record.spec), WEIGHT_PATH);
    add(index, at, indexTokens(record.description), WEIGHT_DESCRIPTION);
  }
}

/** Build the index over every project map, in the order given. */
export function buildDomainMapIndex(maps: ProjectDomainMap[]): DomainMapIndex {
  const index: DomainMapIndex = {
    records: [],
    postings: new Map(),
    aliasExact: new Map(),
    projects: [],
  };
  for (const map of maps) addProjectToIndex(index, map);
  return index;
}

/**
 * Record one field's tokens.
 *
 * A token repeated across fields keeps its HIGHEST weight rather than summing:
 * a record that names a word and also mentions it three times in prose is not
 * four times the answer, and summing let long descriptions dominate.
 */
function add(index: DomainMapIndex, record: number, tokens: string[], weight: number): void {
  for (const token of new Set(tokens)) {
    if (token.length < 2) continue;
    const postings = index.postings.get(token);
    if (!postings) {
      index.postings.set(token, [{ record, weight }]);
      continue;
    }
    const existing = postings.find((posting) => posting.record === record);
    if (!existing) postings.push({ record, weight });
    else if (weight > existing.weight) existing.weight = weight;
  }
}
