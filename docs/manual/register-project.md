---
handbook_version: "1"
id: register-project
title: プロジェクトを登録して解析する
summary: 解析したいリポジトリに名前を付けて登録し、最初の解析を行います。
order: 10
status: draft
verified_revision: b8ecdb9
source_refs:
  - README.md
  - src/adapters/cli.ts
  - spec/feature/analysis-procedure.md
---

# プロジェクトを登録して解析する

<a id="what"></a>
## できること

リポジトリを名前付きで登録しておくと、以降のコマンドを `--project <名前>` で呼べます。
解析結果はキャッシュされ、変更のないファイルは次回から読み直しません。

<a id="before"></a>
## 始める前に

- Node.js 20 以上と、ビルド済みの Anatomia（`npm install` と `npm run build`）が必要です。
- 解析するリポジトリのパスを用意します。登録だけならリポジトリは変更されません。

<a id="start"></a>
## 操作する

```sh
node bin/anatomia.mjs project add sample-game <リポジトリのパス>
node bin/anatomia.mjs project analyze sample-game
```

登録済みの一覧は `project list`、登録の取り消しは `project remove <名前>` です。
登録せずに 1 回だけ解析するときは、各コマンドに `--repo <パス>` を付けます。

<a id="check"></a>
## 成功を確かめる

`project analyze` がファイル数・関数数・検出したドメインの要約を出して終われば成功です。
`project list` に名前が出ていることも確かめられます。

<a id="trouble"></a>
## 困ったとき

- **ドメインが 0 件**: リポジトリに `spec/domains/*.domain.json` が無いと、ドメインの所属が決まりません。
  宣言を書いた後は JSON として正しいか（読み込めないファイルは無視されます）を確かめてください。
- **コマンドが古い動きをする**: Anatomia のコードを更新したら `npm run build` をやり直してください。
  CLI はビルド結果（`dist/`）を読みます。
- **同じ名前で登録し直したい**: `project remove` で消してから `project add` します。

<a id="next"></a>
## 次にできること

- [書く前に着地点と手本を確かめる](./before-coding.md)
- [管理パネルでドメインを眺める](./browse-panel.md)
