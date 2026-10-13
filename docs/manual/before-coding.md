---
handbook_version: "1"
id: before-coding
title: 書く前に着地点と手本を確かめる
summary: 作業の説明から、置き場所となるドメイン・効く決まり・手本の関数・作業計画を受け取ります。
order: 20
status: draft
verified_revision: b8ecdb9
source_refs:
  - README.md
  - src/adapters/cli.ts
  - spec/feature/context-supply.md
  - spec/feature/domain-plan.md
---

# 書く前に着地点と手本を確かめる

<a id="what"></a>
## できること

これから書く作業を一文で伝えると、次を返します。

- `where`: どのドメイン・どの層に置くのが自然か
- `context`: 効く決まり、手本にできる関数、影響が及ぶ範囲、似た既存処理をまとめた「文脈の束」
- `plan`: 作業をドメイン単位に分けた計画（予定するファイル、手本、層の依存に関する警告、確認したい点）

<a id="before"></a>
## 始める前に

- [プロジェクトを登録して解析](./register-project.md)しておきます。
- `plan` は既定で作業の分解に LLM を使います。LLM を使わない決定的な分解だけにするときは `--no-llm` を付けます。

<a id="start"></a>
## 操作する

```sh
node bin/anatomia.mjs where   --project sample-game --task "凍結エフェクトを追加する"
node bin/anatomia.mjs context --project sample-game --task "凍結エフェクトを追加する"
node bin/anatomia.mjs plan    --project sample-game --task "凍結エフェクトを追加する"
```

複数のリポジトリにまたがる計画は `plan` に `--project` を繰り返して渡します。
どのリポジトリか分からない作業は、`map search "<作業の説明>"` で全プロジェクトから候補を探せます。

<a id="check"></a>
## 成功を確かめる

`plan` の結果に、作業ごとの着地ドメイン・予定ファイル・手本の関数が並びます。
決められなかった点は「確認したいこと」として出るので、人が答えてから書き始めます。

<a id="trouble"></a>
## 困ったとき

- **着地点が決まらない（unresolved）**: 新しい機能か、作業の言い回しがドメインの説明と合っていません。
  ドメイン名や既存の機能名を含めて言い直すか、「確認したいこと」に答えてください。
- **手本がテストコードになる**: 手本は実装側の関数を優先します。テストしか無いドメインではテストが残ります。
- **層の依存の警告が出る**: 予定した依存の向きが、そのリポジトリの層の決まりに反しています。書く前に置き場所を見直してください。警告で処理が止まることはありません。

<a id="next"></a>
## 次にできること

- [書いた後に変更を検査する](./verify-changes.md)
