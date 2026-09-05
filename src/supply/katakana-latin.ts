/**
 * src/supply/katakana-latin.ts — Katakana loanwords ↔ their latin spelling.
 *
 * The deterministic domain detection (`plan --no-llm`, `where`) scores token
 * overlap between the task text and a domain's description. Japanese tasks
 * write loanwords in katakana ("デモ", "シェーダ", "テクスチャ") while domain
 * descriptions and identifiers use the latin word (`demo`, `shader`,
 * `texture`), so the same concept never overlaps. Measured 2026-09-05: Pictor's
 * `samples-and-tools` describes itself as "demo アプリ群…" and
 * `plan --no-llm --task "切り絵のデモを実装する"` could not reach it.
 *
 * This is a small EXPLICIT table over the vocabulary Anatomia deals with, not a
 * general romaji transliterator. A general converter would map arbitrary
 * katakana onto plausible latin words and pull unrelated domains into the
 * result, which is worse than missing one: a katakana word not in the table is
 * passed through unchanged rather than nudged towards a near neighbour.
 *
 * SRP: the table and the lookup. Tokenizing and scoring are relevance.ts.
 *
 * @spec 決定的検出のカタカナ語照合
 */

/**
 * Katakana → latin, longest key first at lookup time so "テクスチャ" wins over
 * a shorter key that is a prefix of it.
 */
const KATAKANA_TO_LATIN: ReadonlyArray<readonly [string, string]> = [
  ["デモ", "demo"],
  ["サンプル", "sample"],
  ["シェーダ", "shader"],
  ["テクスチャ", "texture"],
  ["レンダ", "render"],
  ["レンダリング", "render"],
  ["キャッシュ", "cache"],
  ["レイヤ", "layer"],
  ["レイヤー", "layer"],
  ["シーン", "scene"],
  ["マテリアル", "material"],
  ["パレット", "palette"],
  ["ドメイン", "domain"],
  ["モジュール", "module"],
  ["グラフ", "graph"],
  ["ゲート", "gate"],
  ["ビュー", "view"],
  ["スクリーン", "screen"],
  ["メッシュ", "mesh"],
  ["アニメーション", "animation"],
  ["フィルタ", "filter"],
  ["バッファ", "buffer"],
  ["パイプライン", "pipeline"],
  ["プラグイン", "plugin"],
  ["テスト", "test"],
  ["レビュー", "review"],
  ["インデックス", "index"],
  ["エクスポート", "export"],
  ["インポート", "import"],
];

/** Table entries sorted longest-first, so a longer word is matched before a prefix. */
const ENTRIES = [...KATAKANA_TO_LATIN].sort((left, right) => right[0].length - left[0].length);

/**
 * Latin spellings for every table word occurring anywhere in `text`.
 *
 * A SUBSTRING scan, not an exact token match: the relevance tokenizer never
 * splits a Japanese run into words (it emits the whole run plus character
 * bigrams), so "切り絵のシェーダを修正" arrives as one token and an exact-match
 * lookup would find nothing. Each latin word is returned once however many
 * times its katakana form appears — the token set is what matters, and
 * repeating it would silently reweight the score.
 */
export function latinTokensForKatakana(text: string): string[] {
  const out: string[] = [];
  for (const [katakana, latin] of ENTRIES) {
    if (text.includes(katakana) && !out.includes(latin)) out.push(latin);
  }
  return out;
}
