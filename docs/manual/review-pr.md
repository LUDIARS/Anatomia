---
handbook_version: "1"
id: review-pr
title: PR 全体を構造レビューする
summary: ブランチの変更全体について、対象ドメイン・孤立した関数・複雑さの変化をまとめて確かめます。
order: 40
status: draft
verified_revision: b8ecdb9
source_refs:
  - src/adapters/cli.ts
  - spec/feature/pr-diff-review.md
  - spec/feature/code-review.md
---

# PR 全体を構造レビューする

<a id="what"></a>
## できること

- `pr-review`: 基準のコミットからの変更全体について、変更が属するドメイン、所属の決まっていない関数、
  静的な呼び出し元が無い変更関数、関数ごとの複雑さの比較材料をまとめて返します。
- `review`: リポジトリ全体の構造（違反・結合の大きい関数・循環・重複・呼び出し元の無い関数・仕様に結びつかないファイル）を一覧にします。

<a id="before"></a>
## 始める前に

- `pr-review` はブランチを checkout した状態で、比較の基準（例: `main`）を指定します。

<a id="start"></a>
## 操作する

```sh
node bin/anatomia.mjs pr-review --repo . --base main --json
node bin/anatomia.mjs review --project sample-game
```

<a id="check"></a>
## 成功を確かめる

`pr-review` の結果で、変更の対象ドメインが決まっていて（target domain が空でない）、
所属未定の関数が無ければ、ドメインの観点では審査に進める状態です。

<a id="trouble"></a>
## 困ったとき

- **target domain が見つからない**: 変更したファイルがどのドメインの所属宣言にも入っていません。
  `spec/domains/*.domain.json` の所属パターンに追加してください。
- **呼び出し元が無いと出る関数が実際は使われている**: 親クラスやインターフェース越しに呼ばれる関数は、
  「呼び出し元なし」とは別の欄（配送されうる関数）に出ます。公開部品として残す関数は
  `.anatomia/entrypoints.json` に宣言すると「宣言済みの入口」として分けて表示されます。

<a id="next"></a>
## 次にできること

- [管理パネルでドメインを眺める](./browse-panel.md)
