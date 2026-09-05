---
task: domain-review-by-layer
project: Anatomia
kind: 実装
created: 2026-09-05
memory_links: []
---
# domain-review --by-layer で層ごとにレビューできるようにする (A-9)

## 目的
設計書 `Ars/spec/plan/2026-09-05-anatomia-domain-plan-tool.md` §7.2 A-9。
`domain-review` は taxonomy 全体の指標しか出さず、層単位の集計・ゲートが無い。
§7 の思想「プログラムドメインはレイヤ図とリストで視認でき、レイヤごとにレビューできる」
のレビュー側が欠けている。

## 完了条件
- `domain-review --by-layer` を足し、層ごとに coverage / 違反依存 / 未分類 / 凝集を集計する。
- Revisor 所見も層単位で出せるようにする (どの層が薄いかが所見から分かること)。
- 層宣言が無いリポでも既定の層順で集計できること (A-7 の宣言があればそれに従う)。
- 集計結果の順序が決定的であること (層順 → 名前順) をテストで固定する。
- gate ではなく lens として exit 0 を維持する。
- `npm run typecheck` / `npm test` green、`npm run build`。Revisor local PR 提出。

## スコープ (編集可ディレクトリ)
- `src/review/` / `src/domains/program/`
- `src/adapters/cli.ts`
- `spec/feature/domain-review.md` / `spec/interface/cli.md`
