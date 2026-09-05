---
task: plan-katakana-latin-match
project: Anatomia
kind: 実装
created: 2026-09-05
memory_links: []
---
# 決定的ドメイン検出でカタカナ語と英字語を突き合わせる

## 目的
`anatomia plan` / `where` の決定的検出 (`src/supply/detectors.ts` + `relevance.ts`) は
task とドメイン description のトークン重なりで判定する。日本語の task は
カタカナで外来語を書き (「デモ」「シェーダ」「テクスチャ」)、ドメイン description と
実装識別子は英字で書かれている (`demo` アプリ群、`shader`、`texture`) ため、
同じ概念を指していてもトークンが一致しない。

2026-09-05 実測: Pictor の `samples-and-tools` は description に
「demo アプリ群、ベンチマーク、変換/検証ツール」と書いてあるが、
`plan --no-llm --task "切り絵のデモを実装する"` は「デモ」と `demo` を結べず、
このドメインを候補に出せない (結果は unresolved + questions で人間に投げる)。
LLM 分解経路は正しく分解できるので、これは決定的フォールバック側だけの穴である。

## 完了条件
- カタカナ語を対応する latin 表記へ正規化するトークン変換を `relevance.ts` に足し、
  検出のトークン集合に両方を入れる。辞書は Anatomia が扱う語彙 (demo / shader /
  texture / render / cache / layer / scene / material / palette 等) に限った
  小さな明示テーブルとし、汎用ローマ字変換は作らない (誤変換で無関係ドメインを
  引き当てるほうが害が大きい)。
- 現行 tokenizer は日本語文を単語分割せず文字 2-gram にするため、辞書キーが
  日本語 run の一部に現れた場合も latin token を 1 回だけ追加する
  (例: `切り絵のシェーダを修正` から `shader`)。完全一致 token だけを見る実装にしない。
- 変換した語は元のカタカナ語と同じ重みで IDF に載せる (`scoreDomains` の
  matchable 集合の定義を変えない)。
- テストで `plan --no-llm --task "切り絵のデモを実装する"` 相当の入力が
  `samples-and-tools` 相当のドメイン (description に `demo` を含む) を返すことを固定する。
  併せて「デモ」が無関係ドメインを引き当てないことも固定する。
- 辞書に無いカタカナ語は従来どおり素通し (無言で近い語へ寄せない)。
- `npm run typecheck` / `npm test` green、`npm run build`。Revisor local PR 提出。

## スコープ (編集可ディレクトリ)
- `src/supply/relevance.ts` / `src/supply/detectors.ts`
- `src/supply/__tests__/`
