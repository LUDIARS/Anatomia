---
task: plan-layer-dependency-warning
project: Anatomia
kind: 実装
created: 2026-09-05
memory_links: []
---
# plan の予定パスが層間依存に反しないか事前警告する (A-11)

## 目的
設計書 `Ars/spec/plan/2026-09-05-anatomia-domain-plan-tool.md` §7.2 A-11。
`anatomia plan` (PR #1386) は各 item に `layer` を持つが、それは
「手本がどの層にいるか」を示すだけで、**item 間の層依存が宣言に反しないかを見ていない**。
書く前に気づける層違反を、書いた後の `layerViolation` まで持ち越している。

## 完了条件
- plan item に安定した item id と依存先 item id (`dependsOn[]`) を持たせ、LLM 分解では
  予定している依存方向を明示する。`plannedPaths` だけから item 間の依存を推測しない
  (パスの層からは依存辺の有無・向きが分からないため)。決定的 fallback で依存を
  確定できない場合は空配列にし、その限界を `notes[]` に残す。
- `dependsOn[]` の辺について、両 item の `plannedPaths` が属する層の依存関係が層宣言 (A-7 の
  `.anatomia/layers.json` の `order` / `allow`、無ければ現行 `LAYER_RANK`) に
  反しないかを判定し、反するものを **警告として** plan 出力に出す。
  plan は gate ではないので exit code は変えない。
- plan の保存形状を変えるため `PLAN_VERSION` を更新し、保存・読込 validation と
  Markdown / JSON / OKF の全出力で item id・依存辺・警告を欠落させない。
- 新規ドメインの description は LLM 下書きであることを明示し、「要人間レビュー」を付けて
  `questions[]` に載せる (現状は questions に載るが、下書きである旨の明示が弱い)。
- 層が決まらない item (新規ドメイン / 予定パスが層外) は違反と断定せず、
  `unresolved[]` に回す (判断できないことを判断できたことにしない)。
- 違反あり / 違反なし / 層不明 / 依存不明 (決定的 fallback) の 4 ケースをテストで固定する。
- `npm run typecheck` / `npm test` green、`npm run build`。Revisor local PR 提出。

## 前提
A-7 (`layers-declared-order`) が入っていると宣言に従えるが、無くても現行 `LAYER_RANK`
で成立するので、A-7 の完了を待たずに着手してよい。

## スコープ (編集可ディレクトリ)
- `src/supply/plan/`
- `src/domains/program/` (層設定・依存可否判定を `program-domain-view` と共有)
- `spec/feature/domain-plan.md`
