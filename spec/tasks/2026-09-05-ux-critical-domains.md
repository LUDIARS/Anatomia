---
task: ux-critical-domains
project: Anatomia
kind: 実装
created: 2026-09-05
memory_links: []
---
# UX 直結ドメインに uxCritical を持たせてレビュー段階を上げる (A-10)

## 目的
設計書 `Ars/spec/plan/2026-09-05-anatomia-domain-plan-tool.md` §7.2 A-10。
§7 の思想「UX と直結するドメインはレビューとテストを強化する」に対応する仕組みが無い。
scene/screen は `businessDomainIds` を持つが、「UX 直結」の印と、それに応じた
レビュー/テスト強化の方針が存在しない。

## 完了条件
- ビジネスドメインに `uxCritical` を持たせる。明示指定と、scene/screen 所有からの導出の
  両方を受ける (導出値と明示値が食い違うときは明示が勝ち、食い違いを報告する)。
- screen の宣言ファイル / 直接 entry symbol に対する承認済み `domain-owns-code` を
  「UX 直結」の導出根拠にする。scene の推移的な `activeDomainIds` は呼出し先の内部処理まで
  含むため、それだけを根拠に全到達ドメインを `uxCritical` にしない。
- `plan` の item が uxCritical なドメインに着地するとき、出力にその旨を出す
  (レビュー観点: 画面遷移・入力・エラー表示)。plan の検出 taxonomy と business domain は
  同名とは限らないため、承認済み code owner と plan candidate の implementor の対応から
  stable business-domain id を引き、名前一致だけで `uxCritical` を引き継がない。
- `test-suggestions` で uxCritical ドメインのテスト候補を必須扱いにする。既存 API は
  検出 taxonomy の domain 名を入力に取るため、ビジネスドメインの承認済み
  `domain-owns-code` から implementor を解決して focused-testing 入力へ渡す橋渡しを明示し、
  同名 domain だと仮定しない。
- `verify` / `domain-review` でレビュー段階を上げる (どう上げるかは所見の強調までとし、
  block へ昇格させるかは別判断)。
- 導出あり / 明示あり / 両方あり (食い違い) に加え、推移的に到達するだけの domain と
  同名だが owner 対応の無い domain を誤って対象にしないケースをテストで固定する。
- `npm run typecheck` / `npm test` green、`npm run build`。Revisor local PR 提出。

## スコープ (編集可ディレクトリ)
- `src/knowledge/domain/` / `src/domains/`
- `src/supply/plan/` / `src/domains/focused-testing.ts`
- `spec/feature/domain-dual-layer.md` / `spec/feature/focused-testing.md`
