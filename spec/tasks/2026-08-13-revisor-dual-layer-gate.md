---
task: revisor-dual-layer-gate-20260813
project: Anatomia
kind: 実装
created: 2026-08-13T04:00:00.000Z
memory_links:
  - spec/feature/domain-dual-layer.md
  - spec/feature/pr-diff-review.md
---
# Revisor 二層ドメイン gate (pr-diff-review 拡張)

## 目的
[domain-dual-layer.md](../feature/domain-dual-layer.md) のレビュー指針を
`anatomia pr-review` (PrDiffReview) に載せる。コードは「プログラムドメインに紐づかない = NG /
ビジネス紐づけなし = 許容」、spec は「ビジネスドメインに紐づかない = NG / プログラム紐づけなし = 許容」。

## 完了条件
- [ ] `PrDiffReview.domain` を二層判定に拡張: 変更 CodeSymbol の `unclassified` (layer 設定欠落・分類不能配置) を block 判定として返す。
- [ ] `PrDiffReview.spec` を拡張: 変更 / 新規 SpecClause がどのビジネスドメインにも owned されない場合を block 判定として返す。
- [ ] 判定は PR worktree のドメイン定義 / layer 設定で行う (一時性契約維持、`--project` 禁止のまま)。PR 内で宣言を足せば同 PR で解消できる。
- [ ] 逆方向 (コード×ビジネス、spec×プログラム) は判定に使わず、情報表示のみ。
- [ ] 移行併走: 現行 domain gate (.json 紐づけ) と新判定を併走させ、新判定は advisory から開始できる切替フラグを持つ。
- [ ] typecheck / vitest green。NG / 許容 / 解消 (PR 内宣言追加) の各ケースのテスト。

## スコープ (編集可ディレクトリ)
- `src/review/`, `src/branch/`, `src/domains/`, `src/adapters/cli.ts`
