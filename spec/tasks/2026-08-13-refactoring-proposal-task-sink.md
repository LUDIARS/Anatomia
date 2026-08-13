---
task: refactoring-proposal-task-sink-20260813
project: Anatomia
kind: 実装
created: 2026-08-13T04:00:00.000Z
memory_links:
  - spec/feature/viewer-scene-domain-tabs.md
  - spec/feature/code-review.md
---
# リファクタリング提案生成 + 調整タスク発行 (task sink)

## 目的
決定的解析 signal から RefactoringProposal を生成し、プログラムサブタブから調整タスクを
発行できるようにする。Anatomia 自身はコードを書き換えない (検出専用原則の維持)。

## 完了条件
- [ ] RefactoringProposal 生成: misfit 関数 / 低 cohesion / layer 違反エッジ / cycle / structuralDup の signal から、対象 stable IDs・`file:line`・根拠 (指標値と閾値)・提案アクション (move / split-module / break-cycle / dedupe / layer-fix)・影響半径を持つ proposal を作る。
- [ ] 決定的 `proposalId`: signal rule + 対象 stable IDs + 提案 action + 閾値設定から導出。
- [ ] task sink: pluggable (既定 Memoria タスク、Cc task workflow への登録も設定可)。発行は proposal record の knowledge log 追記 + sink 転送。`proposalId` を冪等キーとして重複タスクを作らない。
- [ ] 発行済みタスク status (open / done) を `proposalId` に対応付けて表示。signal 解消済み proposal は active view から除外し再提案を抑止。
- [ ] `POST /api/projects/:id/refactoring-tasks` (mutation、ANATOMIA_WEB_TOKEN ゲート + confirm 必須)。
- [ ] typecheck / vitest green。sink はモックで hermetic にテスト。

## スコープ (編集可ディレクトリ)
- `src/review/`, `src/knowledge/`, `src/adapters/web/`, `src/adapters/`, `public/`
