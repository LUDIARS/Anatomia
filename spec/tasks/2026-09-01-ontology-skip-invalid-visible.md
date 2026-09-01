---
task: ontology-skip-invalid-visible
project: Anatomia
kind: 実装
created: 2026-09-01
memory_links: []
---
# 壊れたドメイン定義 JSON を無警告で捨てない (skipInvalid の可視化)

## 目的
`src/domains/ontology.ts` の `loadFromDir()` は `skipInvalid: true` (auto-discovered な
`spec/domains/` / `.anatomia/domains/`) のとき、パース失敗・検証失敗したファイルを
`continue` で黙って落とす。落ちた宣言は下流で「宣言し忘れ」(`target domain is still missing`)
と区別がつかず、AIFormat `HARNESS.md` §2.0 に「書いたら JSON parse を必ず通す」と
記憶頼みの注意を書く羽目になっている。RULE_CODE §7 (失敗を黙って成功扱いにしない) /
§7.1 (無言フォールバック禁止) に反する。

## 完了条件
- `LoadOntologyOptions` に `onSkip?: (skip: { file: string; reason: string }) => void` を足す。
  `loadFromDir()` は skipInvalid で落とす 3 経路 (lstat 失敗 / 非 regular file / parse・検証失敗)
  すべてで `onSkip` を呼ぶ。
- 既定の listener は `console.warn("[anatomia] ontology definition skipped: <file>: <reason>")`
  (stderr)。無言経路を残さない。
- `ontology.test.ts` に (a) listener が落ちた全ファイルと理由を受け取る、(b) listener 未指定時に
  `console.warn` が 1 回呼ばれる、の 2 テストを足す。
- `where` / `verify` / pr-review の出力に skipped 一覧を載せるかは別判断 (この PR は warn まで)。
- `npm run typecheck` / `npm test` green、`npm run build` (CLI は dist を読む)。Revisor local PR 提出。
- `spec/domains/` 配下の該当ドメイン (domains レイヤ) の membership に本変更が含まれることを
  `anatomia verify` で確認する。

## スコープ (編集可ディレクトリ)
- `src/domains/ontology.ts` / `src/domains/ontology.test.ts`
