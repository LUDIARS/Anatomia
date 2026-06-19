# feature: ドメイン検出（G3）

## 目的

コードベースに既に存在する「ドメイン」（戦闘・移動・通知など、その codebase 固有の機構）を
検出する。これにより supply 時に「既存ドメインを再発明させない」材料を、verify 時に
duplication ゲートの比較対象（ドメインカード）を供給する。

## 振る舞い

`detectDomains(ontology, graph, functions)`（`src/domains/detect.ts`）。各ドメイン定義の
presets + templates を述語（Predicate）にコンパイルし、グラフ上で評価して以下を出す：

- **implementors**: ドメインのルールが触れる関数集合（NodeFilter にマッチしたノード ∪
  template マッチに現れる anchor）。
- **violations**: 見つかった違反。
- **conforms**: そのドメインに `error` 重大度の違反が無ければ true。

## オントロジー（プラグイン式）

`loadOntology(pluginDir?)`（`src/domains/ontology.ts`）。`BUILTIN_DOMAINS` に加え、
plugin dir（`ANATOMIA_PLUGIN_DIR` または明示 dir）配下の `.json` / `.mjs` から DomainDef を
ロード・検証する。Project ごとに `ontologyDir` を持てる（→ data/project-cache.md）。

## ドメインカード（LLM 蒸留）

実プロバイダ（`ANTHROPIC_API_KEY`）があるとき、implementors を持つ各ドメインを
`generateCard`（`src/domains/card.ts`）で LLM 蒸留しカード化する。カードの
`summary + rules` テキストが duplication ゲートの比較対象になる。蒸留結果は
content-addressed キャッシュに載るので、ドメインが変わらなければ LLM を再呼びしない
（→ [data/llm-cache.md](../data/llm-cache.md)）。

## 制約

- 実プロバイダ未設定なら蒸留は走らず（hash-embedder + mock）、duplication は always-pass の
  hermetic 動作になる（テスト/API 不要経路）。
- ゲーム向けドメインオントロジー（B-3）は `NodeFilter.pathPattern` 前提で未完。

## 関連

- 利用先: [feature/verify-gates.md](./verify-gates.md)、[feature/context-supply.md](./context-supply.md)
- データ: [data/llm-cache.md](../data/llm-cache.md)
