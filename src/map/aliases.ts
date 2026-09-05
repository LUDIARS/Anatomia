/**
 * src/map/aliases.ts — Spelling normalisation and tokenisation (design §12.2-5).
 *
 * The index is queried with whatever a person typed. 「トランポリンカウンター」,
 * 「トランポリン カウンター」, 「ﾄﾗﾝﾎﾟﾘﾝｶｳﾝﾀ」 and "trampoline counter" are the
 * same thing, and an index that only stores the display name matches none of
 * them. So every record carries NORMALISED alias keys, and a query is
 * normalised the same way before it is looked up.
 *
 * Normalisation is intentionally lossy in exactly the ways Japanese spelling
 * varies: NFKC folds 全角/半角 (including 半角カナ), katakana folds to hiragana,
 * and the separators that carry no meaning between words (spaces, middle dots,
 * the long-vowel mark, hyphens, underscores) are dropped. That makes
 * 「カウンター」 and 「カウンタ」 one key, which is the whole point.
 *
 * Scoring tokens reuse the supply detector's tokenizer (supply/relevance.ts
 * `tokenizeRelevanceText`): it already splits camelCase, lowercases, and — the
 * reason a Japanese task scored nothing before — emits character BIGRAMS for
 * kana/kanji runs. Re-deriving a second Japanese tokenizer here would let the
 * map and the plan disagree about what a task says.
 *
 * SRP: string normalisation only. No index, no scoring.
 */
// @implements SPEC-domain-map

import { tokenizeRelevanceText } from "../supply/relevance.js";

/** Separators that carry no meaning inside a product name. */
const SEPARATORS = /[\s\u3000_\-\u2010-\u2015\u30fb\uff65\u30fc\u002e\u30fb·・:;,/\()[\]{}「」『』【】"'`]+/g;

/**
 * The alias KEY of a string: the form two spellings of the same name share.
 *
 * Returns "" for text that normalises away entirely — callers must drop those
 * rather than index an empty key that every query would hit.
 */
export function normalizeAlias(text: string): string {
  const folded = katakanaToHiragana(text.normalize("NFKC").toLowerCase());
  return folded.replace(SEPARATORS, "");
}

/** Katakana → hiragana, so 「カウンタ」 and 「かうんた」 share a key. */
export function katakanaToHiragana(text: string): string {
  return text.replace(/[\u30a1-\u30f6]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60),
  );
}

/**
 * Alias keys for one display name.
 *
 * A name like "uni-jump — トランポリン カウンター" yields the whole normalised
 * string AND each side of its separators, because a person names the product by
 * either half. Segments shorter than two characters are dropped: a one-letter
 * key matches nearly everything.
 */
export function aliasKeys(...names: (string | null | undefined)[]): string[] {
  const keys = new Set<string>();
  for (const name of names) {
    if (!name) continue;
    const whole = normalizeAlias(name);
    if (whole.length >= 2) keys.add(whole);
    const parts = name
      .split(/[\s\u3000\u2014\u2015\u2500|/]+/)
      .map(normalizeAlias)
      .filter((part) => part.length >= 2);
    for (const part of parts) keys.add(part);
    // Adjacent parts joined: the spaced catalog name is typed as one word far
    // more often than as two, while the whole-name key also carries the id half
    // (the "uni-jump" half of a catalog entry whose name pairs an id and a title).
    for (let at = 0; at + 1 < parts.length; at++) keys.add(`${parts[at]}${parts[at + 1]}`);
  }
  return [...keys].sort();
}

/**
 * Scoring tokens of a text: identifier tokens + Japanese bigrams (from the
 * shared relevance tokenizer) plus the same tokens after alias normalisation,
 * so 「カウンター」 in a record and 「カウンタ」 in a query still share bigrams.
 */
export function indexTokens(text: string): string[] {
  if (!text) return [];
  const normalized = katakanaToHiragana(text.normalize("NFKC"));
  return [...new Set([...tokenizeRelevanceText(text), ...tokenizeRelevanceText(normalized)])];
}

/**
 * Generic task boilerplate, removed from a QUERY before it is tokenised.
 *
 * Every Japanese instruction ends in 「〜を実装する」 / 「〜を修正する」, and those
 * characters are also in the title of every design document in the index. Left
 * in, they make 「量子暗号の鍵配送を実装する」 match 「ハーネス状態カード — 実装
 * スペック」 on 「実装」 alone, and the zero-hit case — the one `plan` turns into
 * its 「索引に無い」 question — never occurs.
 *
 * Only the phrases that describe the ACT of working, never a subject: a word
 * like 「描画」 or 「認証」 is what the search is for.
 */
const TASK_BOILERPLATE = [
  "実装する", "実装", "修正する", "修正", "追加する", "追加", "対応する", "対応",
  "作成する", "作成", "変更する", "変更", "改善する", "改善", "調査する", "調査",
  "リファクタリング", "スペック", "仕様", "設計", "タスク", "作業", "できるように",
  "したい", "してほしい", "ください", "する", "やる", "作る", "つくる", "直す",
];

/**
 * Scoring tokens of a QUERY: {@link indexTokens} minus the task boilerplate.
 *
 * The boilerplate is replaced with a space rather than deleted so the remaining
 * text does not fuse across the gap into bigrams nobody wrote.
 */
export function queryTokens(text: string): string[] {
  let stripped = text;
  for (const phrase of TASK_BOILERPLATE) {
    stripped = stripped.split(phrase).join(" ");
  }
  return indexTokens(stripped);
}

/**
 * Tokens of a repo-relative path: each segment, plus the segment split on the
 * separators that make up directory names (`uni-jump` → `uni`, `jump`).
 */
export function pathTokens(path: string): string[] {
  const out = new Set<string>();
  for (const segment of path.split("/")) {
    const bare = segment.replace(/\.[a-z0-9]+$/i, "");
    if (bare.length < 2) continue;
    out.add(bare.toLowerCase());
    for (const word of bare.split(/[-_.]/)) {
      if (word.length >= 2) out.add(word.toLowerCase());
    }
  }
  return [...out];
}
