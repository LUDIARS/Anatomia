---
handbook_version: "1"
id: browse-panel
title: 管理パネルでドメインを眺める
summary: ブラウザの管理パネルで、登録したプロジェクトのドメインや関数のつながりを画面で確かめます。
order: 50
status: draft
verified_revision: b8ecdb9
source_refs:
  - README.md
  - src/adapters/web/server.ts
  - src/adapters/web/public/index.html
  - spec/interface/web.md
---

# 管理パネルでドメインを眺める

<a id="what"></a>
## できること

登録した複数のプロジェクトを 1 つの画面で切り替え、ドメインの一覧、ドメインごとの機能のつながり、
仕様とのリンク、関数のグラフなどをタブで見られます。

<a id="before"></a>
## 始める前に

- [プロジェクトを登録](./register-project.md)しておきます。
- 管理パネルは既定でこの PC からだけ開けます（ほかの端末に公開するにはトークンの設定が必要です）。

<a id="start"></a>
## 操作する

```sh
node bin/anatomia.mjs web --port 4200
```

ブラウザで `http://127.0.0.1:4200/` を開き、左のプロジェクト一覧から選んで、上部のタブ（ドメインなど）を切り替えます。

<a id="check"></a>
## 成功を確かめる

ドメインのタブに、検出されたドメインが実装関数の数や違反の数と一緒に並べば表示できています。

<a id="trouble"></a>
## 困ったとき

- **「準備されていません」と出る**: そのプロジェクトの解析結果がまだ作られていません。画面の案内に従って解析を実行してください。
- **最初の表示が遅い**: 起動直後は解析結果の読み込みに時間がかかります。2 回目からはキャッシュから表示されます。

<a id="next"></a>
## 次にできること

- [書く前に着地点と手本を確かめる](./before-coding.md)
