---
task: domain-map-spec-linkage-orphans
project: Anatomia
kind: 実装
created: 2026-09-05
memory_links: []
---
# src/map/ の関数を spec 節へ紐づける (orphan 3 件の解消)

## 目的

PR #1393 (横断ドメインマップ) の Revisor 所見に非ブロックで
「3 changed function(s) are orphaned」が残った。`anatomia verify` の
`spec_linkage` ゲート自体は PASS しており (`src/map/*` と
`src/supply/plan/hints.ts` に `// @implements SPEC-domain-map` を付け、
`spec/feature/domain-map.md` の H1 に `{#SPEC-domain-map}` を与えた)、
残っているのは Revisor 側のナレッジグラフ由来の orphan 判定である。

ファイル単位のアノテーションは付いているが、**関数単位でどの節に対応するか**が
解決できていないと見られる。`[[plan-spec-linkage-orphans]]` (PR #1386 で
`src/supply/plan/` に対して同じ所見が出た件) と同じ性質の残作業で、対象レイヤだけが違う。

## 完了条件

- Revisor の所見に出る 3 関数を特定する (`pr-review` の出力、または
  `git diff` を verify に流して `spec_linkage` の anchors を見る)。
- `spec/feature/domain-map.md` の節構成を、コード側の責務分割
  (索引の作り方 / 更新と再構築 / 検索 / インタフェース) と対応が付く粒度に整え、
  各関数がどの節を実装しているか辿れるようにする。
- ファイル冒頭の `@implements` に加えて、必要なら関数側に `@spec` を足す。
  アノテーションを増やすこと自体が目的ではないので、節と関数の対応が
  1 対 1 で言える箇所に限る。
- 対応後に `pr-review` を回し、orphan 所見が消えることを確認する。
- 同じ判定が `src/supply/plan/` 側でも残っているなら、
  [[plan-spec-linkage-orphans]] と重複した対応をしない (どちらかへ寄せる)。
