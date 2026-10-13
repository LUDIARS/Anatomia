---
handbook_version: "1"
id: verify-changes
title: 書いた後に変更を検査する
summary: 変更差分を 5 つの観点で検査し、周りの決まりから外れた関数を見つけます。
order: 30
status: draft
verified_revision: b8ecdb9
source_refs:
  - README.md
  - src/adapters/cli.ts
  - spec/feature/verify-gates.md
---

# 書いた後に変更を検査する

<a id="what"></a>
## できること

`git diff` の内容を渡すと、変更した関数を次の 5 つの観点で検査します。

| 観点 | 見ていること |
|---|---|
| rule_conformance | ドメインの決まり（禁止された呼び出しなど）に違反していないか |
| duplication | 既存の処理とほぼ同じものを書いていないか |
| spec_linkage | 変更した関数が仕様の節に結びついているか |
| coupling_delta | 結合が、そのリポジトリでは珍しいほど増えていないか |
| convention_drift | 名前や置き場所が周りの書き方とずれていないか |

<a id="before"></a>
## 始める前に

- 検査したい変更をリポジトリの作業ツリーに置きます（コミット前でも構いません）。
- 計画どおりに書いたかも見たいときは、先に `plan` を保存しておきます（[書く前の章](./before-coding.md)）。

<a id="start"></a>
## 操作する

```sh
git diff | node bin/anatomia.mjs verify --project sample-game
git diff | node bin/anatomia.mjs verify --repo <リポジトリのパス> --plan
```

機械で読み取りたいときは `--json` を付けます。

<a id="check"></a>
## 成功を確かめる

最初の行が `PASS` で、5 つの観点がすべて `[PASS]` なら外れはありません。
外れがあると `[FAIL]` の観点の下に、関数名と ID（anchor）が並びます。
ブロック扱いの外れがあると終了コードが 1 になります。

<a id="trouble"></a>
## 困ったとき

- **spec_linkage が落ちる**: 関数のあるファイルが仕様の節に結びついていません。ファイル冒頭のコメントに
  `@spec <仕様の見出し>` を書くか、仕様書の本文からそのファイルを参照します。
- **解析できない**: 失敗として扱われ、合格には読み替えません。差分が空でないか、パスが正しいかを確かめてください。
- **convention_drift の指摘が納得できない**: 周りの多数派との違いを示しているだけです。理由があれば説明を添えてそのままにできます。

<a id="next"></a>
## 次にできること

- [PR 全体を構造レビューする](./review-pr.md)
