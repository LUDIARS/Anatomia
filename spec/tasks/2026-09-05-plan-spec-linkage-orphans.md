---
task: plan-spec-linkage-orphans
project: Anatomia
kind: 実装
created: 2026-09-05
memory_links: []
---
# plan パイプラインの関数を spec 節へ紐づける (orphan 9 件の解消)

## 目的
PR #1386 (`anatomia plan` 導入) の Revisor 所見に非ブロックで
「9 changed function(s) are orphaned」が残った。`src/supply/plan/` に入れた関数群が
`spec_linkage` から見てどの仕様節にも結び付いていない。

同 PR で `spec/feature/domain-plan.md` は追加済みなので、欠けているのは
**コード側から仕様節への明示アノテーション** (`@spec`) と、
節見出しと関数の対応付けである。orphan を放置すると spec_linkage が
「仕様が無い」と「仕様はあるがリンクが無い」を区別できなくなる。

## 完了条件
- `anatomia verify` / `pr-review` で orphan として報告される関数を特定する
  (`git diff` を verify に流し、`spec_linkage` ゲートの anchors を見る)。
- `src/supply/plan/` の各ファイルに `@spec` アノテーションを付け、
  `spec/feature/domain-plan.md` の対応する節 (パイプライン各段 / verify との連結 /
  warm server) を指す。ファイル冒頭の doc コメントに 1 行で足す形とし、
  関数ごとの重複アノテーションは付けない。
- `spec/feature/domain-plan.md` 側の節見出しが、リンク先として解決できる粒度で
  切られていることを確認する (足りなければ節を分ける)。
- 変更後に `git diff | node bin/anatomia.mjs verify --repo .` を回し、
  orphan 件数が 0 になることを確認する。減らせない関数が残るなら、
  なぜ仕様節に対応しないのかを PR 説明に 1 行で書く (黙って残さない)。
- `npm run typecheck` / `npm test` green。Revisor local PR 提出。

## スコープ (編集可ディレクトリ)
- `src/supply/plan/`
- `spec/feature/domain-plan.md`
