# feature: ドメイン検出（G3）

## 目的

コードベースに既に存在する「ドメイン」（戦闘・移動・通知など、その codebase 固有の機構）を
検出する。これにより supply 時に「既存ドメインを再発明させない」材料を、verify 時に
duplication ゲートの比較対象（ドメインカード）を供給する。

planned contract では「コードから semantic domain を決める」のではなく、human-approved domain
へ CodeSymbol を割り当てる evidence と未割当 cluster を検出する。意味・境界・階層の正本は
[`domain-organization.md`](./domain-organization.md)、machine relation は
[`../data/domain-knowledge-log.md`](../data/domain-knowledge-log.md)。

## 振る舞い

`detectDomains(ontology, graph, functions)`（`src/domains/detect.ts`）。各ドメイン定義の
presets + templates を述語（Predicate）にコンパイルし、グラフ上で評価して以下を出す：

- **role**: `semantic`（project domain、未指定時の互換既定）または `policy`（rule評価のみ）。
- **implementors**: ドメインのルールが触れる関数集合（NodeFilter にマッチしたノード ∪
  template マッチに現れる anchor）。
- **violations**: 見つかった違反。
- **conforms**: そのドメインに `error` 重大度の違反が無ければ true。

## オントロジー（プラグイン式）

`loadOntology(pluginDir?)`（`src/domains/ontology.ts`）。`BUILTIN_DOMAINS` に加え、
plugin dir（`ANATOMIA_PLUGIN_DIR` または明示 dir）配下の `.json` / `.mjs` から DomainDef を
ロード・検証する。Project ごとに `ontologyDir` を持てる（→ data/project-cache.md）。

これは現行 reader。T55/T68 後は `loadOntology` が読む DomainDef を knowledge log からの
compatibility projection とし、builtin や plugin を暗黙の project domain にしない。
`state-machine` は本物の project domain 用に予約し、builtin example は
`transition-guard-example` を使う。builtin は `role=policy` として `AnalysisContext.policyResults` に分離し、
rule/violation は保持するが、`AnalysisContext.domains`、domain 件数、primary owner、card、scene、
supply の `existingDomains` には入れない。どこにも割り当てられない CodeSymbol は
`unassigned` のまま返す。

低レベルの `detectDomains()` は semantic と policy の両方を返す。所有情報へ変換する公開 consumer は
`semanticDetectionResults()` で policy を除外し、単一結果から card を生成する経路は policy を
fail-closed で拒否する。これにより `AnalysisContext` を経由しない API 利用でも policy が domain、
screen、scene、Integral seed、boundary label として再流入しない。

## ドメインカード（LLM 蒸留）

実プロバイダ（`ANTHROPIC_API_KEY`）があるとき、implementors を持つ各 semantic domain を
`generateCard`（`src/domains/card.ts`）で LLM 蒸留しカード化する。カードの
`summary + rules` テキストが duplication ゲートの比較対象になる。蒸留結果は
content-addressed キャッシュに載るので、ドメインが変わらなければ LLM を再呼びしない
（→ [data/llm-cache.md](../data/llm-cache.md)）。

## 制約

- 実プロバイダ未設定なら蒸留は走らず（hash-embedder + mock）、duplication は always-pass の
  hermetic 動作になる（テスト/API 不要経路）。
- ゲーム向けドメインオントロジー（B-3）は `NodeFilter.pathPattern` 前提で未完。
- path/name/rule match は assignment evidence であり、単独で owner domain を確定しない。
- semantic owner は最大 1、consumer/related relation は複数を許す。

## 関連

- 利用先: [feature/verify-gates.md](./verify-gates.md)、[feature/context-supply.md](./context-supply.md)
- データ: [data/llm-cache.md](../data/llm-cache.md)
- 整理: [domain-organization.md](./domain-organization.md)
- machine data: [domain-knowledge-log.md](../data/domain-knowledge-log.md)
