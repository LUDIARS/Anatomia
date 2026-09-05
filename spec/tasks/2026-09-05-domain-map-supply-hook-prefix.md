---
task: domain-map-supply-hook-prefix
project: Anatomia
kind: 実装
created: 2026-09-05
memory_links: []
---
# supply hook と Cc delegation seed で map 検索を前置きする (C-11)

## 目的

設計 §12.4 の C-11 が未着手のまま残っている。PR #1393 で索引・API・CLI と
`plan --hints-from-map` までは入ったが、**入口側がまだ map を呼んでいない**。

- Castra の `.claude/hooks/anatomia-supply.mjs` は plan を直接叩いており、
  その前に `GET /api/domain-map/search` を通していない。設計は「plan の前に
  map 検索を前置きし、命中を `--project` 複数と `domainHints` にする」と定める。
- Cc の delegation seed も同様で、委託指示書を作る前に map でプロジェクトと
  ドメインを確定する経路が無い。

現状は人間が `anatomia map search` を手で打った場合しか効かないため、
「作業開始時に自動で当てる」という §12 の目的が達成できていない。

## 完了条件

- supply hook がコーディングプロンプトの前に `GET /api/domain-map/search?q=<指示文>`
  を叩き、命中を「プロダクト → コンテンツ → コアドメイン → 主要パス → 関連サービス」
  の 1 行として前置きする。
- 命中した project を plan 呼び出しの `project` / `projects` に渡す
  (warm server の `POST /api/plan` は既に `map` 既定 ON なので、hook 側は
  project を渡さない選択もありうる。どちらを正とするか決めて 1 本化する)。
- 0 件のときは「索引に無い。新規コンテンツか表記ゆれ」を前置きし、plan の
  `questions[]` と二重に出さない。
- warm server が落ちている / 未登録プロジェクトのときに hook 全体を落とさない
  (map はアクセラレータであり前提ではない)。
- Cc delegation seed 側でも同じ検索を通し、確定した project とドメインを
  指示書へ書く。
- 対象は Castra (`.claude/hooks/`) と Concordia であり、Anatomia 側の実装は不要。
  それぞれのリポの PR として出す。

## 委託元による追記 (2026-09-05)

- Castra 側は実装済み (main `301cae4`、`.claude/hooks/anatomia-supply-map.mjs`)。
- 残るのは Cc delegation seed 側のみで、別委託で進行中。
