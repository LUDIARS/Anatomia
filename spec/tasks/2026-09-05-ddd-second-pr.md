---
task: ddd-second-pr
project: Anatomia
kind: 実装
created: 2026-09-05
memory_links:
  - anatomia-knowledge-edge-endpoints
  - anatomia-domain-membership-source
---
# DDD 第 2 PR — 層宣言・コンテキストマップ・層別レビュー・UX 直結ドメイン (A-7〜A-11)

## 目的

設計書 `Ars/spec/plan/2026-09-05-anatomia-domain-plan-tool.md` §7「DDD に則る」に対して、
Anatomia 側で欠けている / 部分実装だった仕組みを 1 PR にまとめて足す。

§7 の思想と実装の対応（同 §7.1）で「欠落」「部分」と判定された箇所は 5 つあった。

- コアドメインは**リストとグラフ**で記述される → グラフ側（ドメイン間の関係辺）が無い
- 層の依存を避ける → 判定はあるが層順が**コードに固定**されており、リポごとの層数・
  オニオン構成を表現できない
- **レイヤごとにレビュー**できる → `domain-review` は taxonomy 全体の指標しか出さない
- UX と直結するドメインはレビューとテストを強化する → 「UX 直結」の印と方針が無い
- 書く前に層違反へ気づく → `plan` は item の層を持つだけで item 間の依存を見ていない

併せて、第 1 PR (#1386) が残した 2 つの穴（決定的検出がカタカナ語と英字語を結べない、
`src/supply/plan/` の関数が spec 節に紐づいていない）も同じ PR で塞ぐ。

## 完了条件

- **A-7**: `.anatomia/layers.json` に層の順序（`order`）と許可依存（`allow`）を宣言でき、
  `layerViolation` が宣言に従う。無宣言のリポは現行 `LAYER_RANK` の判定を維持する。
  オニオンは `allow` で内向きのみ許可として表現できる。壊れた宣言（未宣言の層名・
  重複した `order`・循環した `allow`・`allow` の key 漏れ）は既定へ落とさず設定エラーにする。
- **A-8**: knowledge に edge kind `domain-relates-domain`（`evidence.relation` は
  `depends-on` / `collaborates` / `shared-kernel`）を足す。候補は program-domain 依存の集約から
  決定的に作り、LLM が下書きし、人間承認を通ったものだけが log に入る。
  `BusinessDomainViewPayload` がリストに加えて関係辺を返す。承認前の候補はビューに出ない。
- **A-9**: `domain-review --by-layer` が層ごとの coverage / 違反依存 / 未分類 / 凝集を集計し、
  Revisor 所見も層単位で出す。層宣言が無いリポでも集計でき、順序は決定的。lens なので exit 0。
- **A-10**: ビジネスドメインが `uxCritical`（明示 or screen 直接 entry からの導出）を持ち、
  明示と導出が食い違うときは明示が勝ち食い違いを報告する。plan / verify / `test-suggestions` /
  `domain-review` へ、承認済み `domain-owns-code` 経由（名前一致ではない）で引き継ぐ。
- **A-11**: plan item が安定した `id` と `dependsOn[]` を持ち、層宣言に反する向きを
  `layerWarnings[]` として Markdown / JSON / OKF すべてに出す。`plannedPaths` から依存は
  推測しない。層が決まらない item は違反と断定せず `unresolved[]` に回す。`PLAN_VERSION` を更新する。
- 決定的検出がカタカナ語と latin 表記を突き合わせる（明示テーブルのみ。汎用ローマ字変換はしない）。
- `src/supply/plan/` の各ファイルに `@spec` を付け、`verify` の `spec_linkage` orphan を 0 にする。
- 各項目にユニットテストを対で足し、README と `spec/feature/`（`domain-dual-layer.md` /
  `domain-review.md` / `domain-view.md` / `domain-plan.md`）を更新する。
- `npm run typecheck` / `npm run build` green、`npm test` は既知の未初期化 submodule
  (`lib/aiformat`) 由来の 1 件を除いて green。Revisor local PR 提出。

## スコープ (編集可ディレクトリ)

- `src/domains/program/` / `src/review/` / `src/knowledge/` / `src/web-cache/`
- `src/supply/` / `src/supply/plan/` / `src/adapters/`
- `spec/feature/` / `README.md` / `.anatomia/layers.json`
