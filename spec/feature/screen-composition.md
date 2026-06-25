# 画面構成の自動学習 (screen composition)

Anatomia は、リポジトリの **UI 画面構成** を静的・決定的に学習し、オントロジー
（ドメイン taxonomy）の一次元として取り込む。`patterns/`（アクセスパターン検出）
と同じ source-scan 方式で、マルチスタック（Web / Unity / native）に対応する。

これは `scenes/`（動的なシーンステート＝局面/FSM）とは直交する **静的な構成** で
ある（role-vision の 3 層: 構造グラフ / ドメイン / シーンステート）。画面はドメイン
側の関心事として扱う。

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
- **domains**: その画面ファイルの関数が属するドメイン（コールグラフ帰属）。

遷移・構成は**ファイル粒度**で帰属する（同一ファイルに宣言された画面はそのファイルの
遷移先・子参照を共有）。1 ファイル 1 画面の一般的なケースでは厳密、複数画面ファイルでは
意図的に粗い（助言的な構造データであり証明ではない）。

## オントロジーへの取り込み

`domains/retune` パイプラインが画面構成を taxonomy に折り込む:

1. **step 1（LLM）への接地**: 検出した画面の要約を step-1 プロンプトへ供給し、
   生成される taxonomy 全体を画面認識にする。
2. **step 8（決定的）**: `screen-composition` ドメインを生成（LLM 非依存、split/merge
   の後に追加して再編されないようにする）。stack×kind ごとに 1 モジュールを作り、
   各モジュールは membership の `pathPattern` で画面ファイルを所有する。これにより
   Domain View に表示され、他の生成ドメインと同様に supply/verify へ流れる。
3. **artifact**: 画面グラフ全体（構成 + 遷移）を `spec/data/<project>.screens.json` に
   コミット成果物として永続化する。

## 取得方法

- CLI: `anatomia screens [--repo <path> | --project <id>] [--json]`
- HTTP（warm サーバ）: `GET /api/projects/:id/screens` → `ScreenGraph`
- retune 実行時: 上記の taxonomy 折り込み + `*.screens.json` 出力

## 限界 / follow-up

- `.vue` 単一ファイルコンポーネントの `<template>` は未解析（`.ts/.tsx/.cs/.cpp/.h` が対象。
  Vue Router のルートテーブルが `.ts` にあれば route は拾える）。
- 遷移/構成のファイル粒度帰属（複数画面ファイルでは粗い）。
- 動的に組み立てる遷移（変数のルート名など、文字列リテラルでないもの）は未解決。
