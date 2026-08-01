# 画面構成の自動学習 (screen composition)

Anatomia は、リポジトリの **UI 画面構成** を静的・決定的に学習し、Scenes view の
scene seed として扱う。`patterns/`（アクセスパターン検出）と同じ source-scan 方式で、
マルチスタック（Web / Unity / native）に対応する。

現行は ScreenGraph を `SceneRef` へ射影する。planned contract では、画面そのものと複数画面に
またがる workflow/module を `SceneDefinitionSeed` として
[scene derivation](./scene-derivation.md) へ渡し、trace の `SceneObservation` とは別経路で
同じ canonical scene ID に結合する。

## 何を学習するか

各画面（`ScreenNode`）について次を抽出する:

- **identity / kind / stack**: 宣言名（`*Page/*View/*Screen` ほか）・種別
  （page / view / panel / dialog / menu / hud / scene）・スタック（web / unity / native）。
- **route**: ルーティングテーブル（`<Route path element>` / `{path, component}`）や
  Next 形式のファイルルート（`app/**/page.tsx`, `pages/**`）から解決した URL。
- **contains（構成）**: その画面が内包する子画面。Web は JSX 子要素 `<Child/>`、
  ゲームは同一ファイル内で参照される既知画面名。
- **navigatesTo（遷移）**: `navigate()` / `router.push()` / `<Link to>` / `redirect()` /
  `SceneManager.LoadScene()` の遷移先。ルートテーブル経由で画面名に解決し、
  解決できない場合は生パスのまま記録する。
- **domains（現行互換）**: その画面ファイルの関数が属するドメイン（コールグラフ帰属）。
  planned manifest では exact direct/reached CodeSymbol を保持し、domain は ownership edge から導出する。

遷移・構成は**ファイル粒度**で帰属する（同一ファイルに宣言された画面はそのファイルの
遷移先・子参照を共有）。1 ファイル 1 画面の一般的なケースでは厳密、複数画面ファイルでは
意図的に粗い（助言的な構造データであり証明ではない）。

## 目標取り込み（planned）

screen detector は code / route / engine asset から source anchor 付き `SceneDefinitionSeed` を返すだけにする。
domain taxonomy の生成入力や manual scene store へ直接書かない。

1. `SceneDefinitionSeed` を canonical Scene / SceneElement identity に正規化する。
2. 独立した子画面は child Scene→parent Scene の `subscene-of`、独立 identity を持たない UI 部品は
   Scene→SceneElement の `scene-contains`、navigatesTo は `scene-transitions-to` にする。
3. entry CodeSymbol から call graph を辿り、direct/reached を区別する。
4. code ownership から active domain、exact code-spec link から related SpecClause を導出する。
5. explicit sync で knowledge log と generated scene OKF を更新する。

画面 detector が見落とした scene は manual JSON で作らず、code annotation / asset detector /
detector config を修正する。人の補足は非権威 annotation overlay に置く。

## 現行 Scenes / オントロジー取り込み（migration source）

画面構成は次の 4 経路で使う:

1. **step 1（LLM）への接地**: 検出した画面の要約を step-1 プロンプトへ供給し、
   生成される taxonomy 全体を画面認識にする。
2. **Scenes view への投影**: web-cache prepare 時に `ScreenGraph` を `SceneRef[]` へ変換し、
   各画面を Scenes view に出す。画面にまたがる workflow/module は手動 scene として同じ
   `spec/data/<project>.scenes.json` に置ける（T66 で annotation-only へ移行）。
3. **retune 互換**: 既存の retune 経路では、supply/verify 互換のため `screen-composition`
   ドメインへの投影も残す。表示上の主語は Scenes view であり、ドメインシーン混合ビューは
   使わない。
4. **artifact**: 画面グラフ全体（構成 + 遷移）を `spec/data/<project>.screens.json` に
   コミット成果物として永続化する（planned contract では generated compatibility projection）。

## 取得方法

- CLI: `anatomia screens [--repo <path> | --project <id>] [--json]`
- HTTP（warm サーバ）: `GET /api/projects/:id/screens` → `ScreenGraph`
- retune 実行時: 上記の taxonomy 折り込み + `*.screens.json` 出力

## 限界 / follow-up

- `.vue` 単一ファイルコンポーネントの `<template>` は未解析（`.ts/.tsx/.cs/.cpp/.h` が対象。
  Vue Router のルートテーブルが `.ts` にあれば route は拾える）。
- 遷移/構成のファイル粒度帰属（複数画面ファイルでは粗い）。
- 動的に組み立てる遷移（変数のルート名など、文字列リテラルでないもの）は未解決。
- planned contract と edge schema: [scene-derivation.md](./scene-derivation.md) /
  [domain-knowledge-log.md](../data/domain-knowledge-log.md)
