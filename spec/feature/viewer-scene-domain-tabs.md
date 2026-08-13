---
title: Anatomia viewer scene/domain tabs
type: feature
service: anatomia
domain: domain-modeling
status: planned
tags:
  - viewer
  - scene
  - business-domain
  - program-domain
  - refactoring-proposal
x-anatomia:
  kind: viewer-scene-domain-tabs
---

# feature: ビューア強化 — シーン / ドメイン二層タブ

## 目的

管理パネル（`anatomia web`）の閲覧面を **シーン** と **ドメイン** の 2 トップタブに再編し、
ドメインタブは [domain-dual-layer.md](./domain-dual-layer.md) の二層
（**ビジネス** / **プログラム**）をサブタブで見せる。層をまたぐ確認（ビジネス⇄プログラム、
シーン→ドメイン、ドメイン→仕様 / クラス図）を 1 クリックの相互ナビゲーションにする。

## タブ構成

```text
[シーン] [ドメイン]
            ├─ [ビジネス]   … 人間調整可・仕様確認
            └─ [プログラム] … 自動導出・クラス図/依存・リファクタリング提案
```

### シーンタブ

- 一覧: canonical SceneManifest（[scene-derivation.md](./scene-derivation.md)）の scene を
  kind / stack ごとに一覧。
- 詳細: 選択 scene について
  - **画面の再現**: 可能な限り画面を再現する。再現手段は忠実度順の fallback：
    1. スクリーンショット / 実行時キャプチャ artifact（あれば）
    2. 静的画面構成（[screen-composition.md](./screen-composition.md)）からの
       ワイヤーフレームレンダリング（レイアウト要素・遷移ボタンを配置した模式図）
    3. SceneElement のツリー表示（最低保証）
    どの忠実度で表示しているかをバッジで明示し、模式図を実画面と誤認させない。
  - **関連ドメインの列挙**: scene の active Domains（ビジネス）と、active CodeSymbols の
    belongs-to から導出した**プログラムドメイン**を両方列挙。各エントリはドメインタブの
    該当層・該当ドメインへ deep link。
  - 遷移: transition edges を隣接 scene への link として表示。

### ドメインタブ — ビジネスサブタブ

- 一覧: approved ビジネスドメインの hierarchy（spec-only / implemented / missing を含め
  非表示にしない）。
- 詳細:
  - **仕様の確認**: owner の SpecClause 群を文書構造（heading / excerpt / `file:line`）で
    表示し、spec 原文ビューへリンク。ドメインの purpose / boundary（authored OKF）を先頭に。
  - **プログラムへのつながり**: 実装 CodeSymbol の belongs-to を集計した
    プログラムドメイン対応（重み付き）を表示。各行からプログラムサブタブの該当ドメインへ
    ジャンプ（相互確認の片翼）。「紐づけなし」領域は空として明示する。
  - 関連 scene（activates 逆引き）。
- **人間による調整**: 既存の整理 UI（[domain-organization.md](./domain-organization.md)
  の Domain canvas / Assignment review / Approval）をこのサブタブに統合する。調整は
  すべて proposal + Gate 経由（即時 CRUD を置かない従来契約を維持）。

### ドメインタブ — プログラムサブタブ

- 一覧: layer ごとにプログラムドメインを一覧（cohesion / modularity Q / misfit 数つき）。
- 詳細:
  - **クラス図**: 所属機能単位の `enclosingType` を集約したクラス図
    （既存 `/api/graph` の `views.class` を流用し、継承 / 実装 / 参照 edge を描画）。
  - **依存関係**: プログラムドメイン間の依存グラフ（越境結合を重みに、layer 違反
    エッジ = 下位層→上位層依存を強調表示）。ドメイン内はモジュール→モジュール粒度へ
    ドリルダウン。
  - **ビジネスへのつながり**: owner edge 集計によるビジネスドメイン対応（重み付き）を
    表示し、ビジネスサブタブの該当ドメインへジャンプ（相互確認のもう片翼）。
    owner の無い CodeSymbol は「紐づけなし」として件数表示。
- **リファクタリング提案 → 調整タスク発行**:
  - 決定的解析の signal（misfit 関数 / 低 cohesion / layer 違反エッジ / cycle /
    structuralDup、[module-layer.md](./module-layer.md)・[code-review.md](./code-review.md)）
    から **RefactoringProposal** を生成する。内容: 対象 stable IDs、`file:line`、根拠
    （指標値と閾値）、提案アクション（move / split-module / break-cycle / dedupe /
    layer-fix）、影響半径。
  - UI で選択した proposal を**調整タスク**として発行できる。発行は proposal record の
    knowledge log 追記 + task sink への転送（sink は pluggable：既定は Memoria タスク、
    Cc task workflow への登録も設定で可）。Anatomia 自身はコードを書き換えない
    （検出専用の従来原則を維持）。
  - 各 proposal は、signal rule、対象 stable IDs、提案 action、閾値設定から決まる決定的な
    `proposalId` を持つ。task sink への発行は `proposalId` を idempotency key とし、同じ
    proposal の再送でタスクを重複作成しない。
  - 発行済みタスクの status（open / done）を `proposalId` に対応付けて表示する。signal が
    解消した proposal は active view から除外し、同一 `proposalId` の再提案を抑止する。

## 相互ナビゲーション契約

- ビジネス⇄プログラムのジャンプは**導出根拠つき**：対応表の各行は経由した
  CodeSymbol（/ SpecClause）件数を持ち、展開すると `file:line` 一覧を出す。
- シーン→ドメイン、ドメイン→シーンの deep link は stable ID ベース
  （label / path を identity にしない）。
- すべての表示は prepared cache（web-cache prepare）から読み、タブを開いた瞬間の
  再解析を発生させない（domain-view の事前集約方式を踏襲）。

## 取得面（案）

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/projects/:id/scene-view` | シーンタブ payload（scene 一覧 + 画面再現データ + 二層ドメイン列挙） |
| GET | `/api/projects/:id/business-domain-view` | ビジネスサブタブ payload（hierarchy + specRefs + program 対応 + scene 逆引き） |
| GET | `/api/projects/:id/program-domain-view` | プログラムサブタブ payload（layer 一覧 + クラス図 + 依存 + business 対応 + proposals） |
| POST | `/api/projects/:id/refactoring-tasks` | 選択 proposal の調整タスク発行（mutation、ANATOMIA_WEB_TOKEN ゲート + confirm 必須） |

既存 `/api/projects/:id/domain-view` は移行期間の互換 read として残し、新 UI は使わない。

## 現行実装との差

- 現行パネルは Domain View / graph / scenes が並列タブで、層の区別が無い。
- 画面再現は現状ワイヤーフレーム相当の材料（ScreenGraph の要素 + 遷移）しか無い。
  キャプチャ artifact の取り込みは trace observation（local overlay）と同じ置き場を使う。
- RefactoringProposal と task sink は新規。signal 自体は module-layer / review が実装済み。

## 関連

- [domain-dual-layer.md](./domain-dual-layer.md) — 二層モデルの定義と Revisor 指針
- [scene-derivation.md](./scene-derivation.md) / [screen-composition.md](./screen-composition.md)
- [domain-organization.md](./domain-organization.md) — 整理 UI（ビジネスサブタブへ統合）
- [module-layer.md](./module-layer.md) / [code-review.md](./code-review.md) — 提案 signal
- [interface/web.md](../interface/web.md) — HTTP API
