---
title: Anatomia domain and scene knowledge log
type: data
service: anatomia
domain: knowledge-model
status: planned
tags:
  - okf
  - domain
  - scene
  - jsonl
x-anatomia:
  kind: domain-knowledge-log
  schema-version: 1
---

# data: domain / scene knowledge log

## 目的と状態

本仕様は、仕様から起こした domain、コードとの割当、subdomain 関係、コードから導出した
scene を、全 adapter が同じ意味で読めるようにする **目標永続契約**である。実装前の
planned contract であり、移行タスクは [`../../TASKS.md`](../../TASKS.md) の T50-T69 と
[`../../docs/plan-okf-domain-scene-flow.md`](../../docs/plan-okf-domain-scene-flow.md) に置く。

狙いは「JSONL と Kuzu のどちらが正本か」を曖昧にしないことにある。

- 人が編集・承認する仕様 OKF は domain の意味、境界、階層の **authoring source**。
- コードと engine asset は implementation fact と scene identity/composition/transition の
  **definition source**。
- raw trace は runtime で実際に観測した事実の **observation source**。
- Git 管理する knowledge JSONL は、authored OKF、code/asset definition、承認済み relation を
  revision 付きで正規化した
  **canonical write / replay state**。write command と rebuild はここを読む。
- Kuzu、generated OKF、taxonomy / DomainDef JSON、Web cache は JSONL から再生成できる
  projection であり、上流へ逆流させない。read adapter は `knowledgeHead`、source revision、
  projection schema を検証できる projection を読んでよい。

authoring source と machine source が食い違う場合は JSONL 側を暗黙更新せず、reconcile を
stale / conflict で停止する。
raw trace は Git 管理 log/scene OKF へ取り込まず、local observation store から query 時に重ねる。
対応 scene の無い phase は provisional diagnostic であり canonical node/edge を作らない。

## データ分類・権威・保護

| データ | 種類 | 派生性 | 権威 | 既定の保存先 | 再生成 | 保護要否・方法 |
|---|---|---|---|---|---|---|
| domain OKF | master | human-authored | 人が承認した仕様 | `<knowledgeWriteRoot>/data/domains/*.md` | 不可 | 条件付き要。private repository は同じ ACL、public repository は保護不要 |
| feature / data 等の仕様 OKF | master | human-authored | 人が承認した仕様本文 | read-only `specDirs[]` | 不可 | 条件付き要。対象 repository の公開範囲と ACL を継承 |
| knowledge JSONL | master | curated machine state | 承認 transaction と source revision | `<knowledgeWriteRoot>/data/domain-map/<project>.knowledge.jsonl` | 上流から reconcile 可。無断再生成不可 | 条件付き要。対象 repository と同じ ACL |
| code / asset | master | external | 対象 repository | 対象 repository | 不可 | 条件付き要。対象 repository と同じ ACL |
| raw trace | user | 行動・実行ログ | 計測器が出した event | Anatomia home / 指定 trace store | 再計測のみ | 要。local/repository ACL 内に閉じ、秘密・個人情報を記録せず、外部公開しない |
| scene manifest / scene OKF / edge JSONL | master | derived projection | code / asset + accepted detector config | `<knowledgeWriteRoot>/data/generated/anatomia/` | 可 | 条件付き要。対象 repository と同じ ACL |
| Kuzu | master | derived local cache | knowledge JSONL + code graph | Anatomia home の project cache | 可 | 要。local-only、対象 repository と同等の利用者だけが読む |
| Kuzu runtime observation overlay | user | derived local cache | raw trace | Kuzu session / trace cache の分離 table | 可 | 要。raw trace と同じ ACL・retention、canonical table と分離 |
| taxonomy / DomainDef / screens / scenes JSON | master | derived compatibility projection | knowledge JSONL | 既存互換 path | 可 | 条件付き要。対象 repository と同じ ACL |
| Web cache | master | derived read model | verified projection + source revisions | Anatomia home の project cache | 可 | 要。local-only、対象 repository と同等の利用者だけが読む |
| proposal | user | agent/operator の作業入力 | 無し。未承認 | project cache / proposal store | 可 | 要。source excerpt を含むため対象 repository と同じ ACL |
| manual annotation | user | 人の入力 | 人が承認した表示注記だけ | `<knowledgeWriteRoot>/data/scene-annotations/` | 不可 | 条件付き要。対象 repository と同じ ACL |

個人情報は通常扱わないが、source path、symbol、仕様本文は private repository の構造を露出し得る。
外部公開・別 repository への複製を既定にせず、元 repository のアクセス制御を継承する。
derived な scene/Kuzu/cache は master data から決定的に作る参照データなので master に寄せる。
proposal/annotation/trace は人や実行行動に起因するため user に寄せる。

- raw trace は project ごとの retention 設定または利用者の明示削除まで保持し、外部同期しない。
- proposal は source revision / expected head が stale になった時点で無効化し、project cache cleanup で削除する。
- annotation は Git 管理 user data とし、削除も通常の repository review を通す。

## 永続レイアウト

対象 repository 内の単一 `knowledgeWriteRoot`（通常 `<repo>/spec`）を基準にする:

```text
<knowledgeWriteRoot>/
└── data/
    ├── domains/                         # 人が編集する domain OKF
    ├── domain-map/
    │   └── <project>.knowledge.jsonl    # 承認済み transaction log
    ├── scene-annotations/               # 任意。表示注記のみ
    └── generated/
        └── anatomia/
            ├── manifest.json            # generator ownership manifest
            ├── scene-manifest.json      # scene projection
            ├── scene-edges.jsonl        # 大量 edge projection
            └── scenes/*.md              # generated OKF projection
```

Kuzu は `<anatomia-home>/cache/<projectId>/knowledge.kuzu` に置き、commit しない。
`specDirs[]` は複数の read root、`knowledgeWriteRoot` は Git 管理 artifact 用の単一 write root とする。
既定 `<repo>/spec` を安全に選べず、明示 root も無い場合は write を fail-fast し、複数 root から
任意の 1 つを選ばない。root の解決契約は
[`../feature/spec-source-config.md`](../feature/spec-source-config.md) を参照する。

## transaction log

knowledge JSONL は **1 承認または 1 code-sync transaction = 1 行**の append-only log とする。
entity ごとに複数行を先に書かず、関連する node / edge の変更を 1 transaction に束ねる。
記録時は UTF-8、LF、canonical JSON、末尾改行を用いる。

説明用に整形した envelope:

```json
{
  "schemaVersion": 1,
  "transactionId": "tx:...",
  "previousHead": "sha256:...",
  "transactionHash": "sha256:...",
  "analysisSnapshotId": "analysis:...",
  "sourceRevisions": {
    "spec": "sha256:...",
    "code": {
      "gitHead": "git:...",
      "contentFingerprint": "sha256:..."
    },
    "trace": null
  },
  "origin": "human-approval | code-sync | migration",
  "operations": [
    {
      "op": "upsert-node | upsert-edge | remove-node | remove-edge | replace-derived-set",
      "record": {}
    }
  ],
  "provenance": {
    "proposalIds": [],
    "approval": {
      "kind": "human | agent | automatic | migration",
      "reviewRef": "git commit / PR ref or null"
    },
    "generatorSchema": 1
  }
}
```

- `transactionHash` は同フィールドを除いた envelope の canonical bytes から計算する。
- `previousHead` は直前の `transactionHash`。先頭だけ `null`。
- proposal の `expectedHead` と現在 head が違えば `409 stale` とし、再解析する。
- 書込みは repository lock 内で、既存全行 + 新行を一時ファイルへ書き、hash chain を再検証後に
  atomic rename する。途中までの append を成功として扱わない。
- 壊れた JSON、未知 schema、hash 不一致、重複 transaction ID、dangling edge は
  **fail-fast**。raw trace / cost feed のように bad line を skip してはならない。
- compaction は元 log の head と各 transaction ID を保持する signed snapshot を別成果物として
  作る。元 log を自動破棄しない。
- 個人名、email、token、Cernere subject ID は knowledge log に保存しない。approval audit は
  actor 種別と、同じ repository の Git commit / PR ref だけを持つ。個人単位の監査が必要な場合は
  Git/Cernere を権威として参照し、JSONL に複製しない。

## stable identity

表示名、path、親 domain、本文 hash を entity ID にしない。

| entity | stable ID の優先順 | revision evidence |
|---|---|---|
| Domain | OKF に明記した immutable ID。新規承認時に一度だけ採番 | domain OKF revision |
| SpecDocument | OKF の明示 ID。無ければ repo-relative path 由来の provisional ID | content hash |
| SpecClause | 明示 clause ID。無ければ document ID + AST structural address（heading ancestry + unit kind + sibling index）由来の provisional ID | normalized clause hash |
| CodeSymbol | language-aware qualified symbol + source identity | Anchor ID、path、range、signature |
| Scene | engine GUID / native ID → explicit code annotation / route → qualified entry symbol → project + source identity hash | code / asset revision |
| SceneElement | scene ID + detector-native element identity | source anchor |

provisional ID は候補比較には使えるが、承認済みの domain/spec binding を長期保持する前に
明示 ID へ硬化する。rename / move は alias transaction で追跡し、別 entity を黙って作らない。
Anchor ID はコード版の evidence であり、body 編集のたびに所有関係そのものを失う ID にはしない。
dirty worktree でも stale を検出できるよう、CodeSymbol/source revision は Git HEAD だけでなく
解析した bytes の content fingerprint を必須とする。

旧 Anchor ID の content-addressing は cache invalidation、dedup、trace→code join には正しい。
本仕様はそれを廃止せず、`content/revision identity` と `lifetime entity identity` の責務だけを分ける。

## node と edge

canonical node kind:

- `domain`
- `spec-document`
- `spec-clause`
- `code-symbol`
- `scene`
- `scene-element`

canonical edge kind と向き:

| edge kind | from → to | 制約 |
|---|---|---|
| `subdomain-of` | child Domain → parent Domain | child の親は最大 1、acyclic、transitive edge は保存しない |
| `domain-owns-spec` | Domain → SpecClause | clause の owner は最大 1 |
| `domain-relates-spec` | Domain → SpecClause | 0..n、owner 以外の関係 |
| `domain-owns-code` | Domain → CodeSymbol | symbol の semantic owner は最大 1 |
| `domain-uses-code` | Domain → CodeSymbol | 0..n、consumer / shared relation |
| `scene-contains` | Scene → SceneElement | composition |
| `subscene-of` | child Scene → parent Scene | domain hierarchy とは独立 |
| `scene-transitions-to` | Scene → Scene | source evidence 必須 |
| `scene-has-entry` | Scene → CodeSymbol | direct entry |
| `scene-activates-code` | Scene → CodeSymbol | call / workflow reachability |
| `scene-activates-domain` | Scene → Domain | `scene-activates-code` + code ownershipから導出 |
| `scene-relates-spec` | Scene → SpecClause | reached code の spec link から導出 |
| `scene-element-realized-by` | SceneElement → CodeSymbol | UI / asset element の実装 |

独立した子画面/子 scene は `child Scene --subscene-of--> parent Scene`、独立 identity を持たない
UI/asset 構成物だけを `Scene --scene-contains--> SceneElement` にする。

Domain の `layer`、cross-cutting `concern`、scene activation は domain hierarchy と直交する。
複数 parent のような cross-cutting 関係は `subdomain-of` へ押し込まず、related / dependency
relation として拡張する。

一般仕様は domain 別ディレクトリへ移動しない。1 document が複数 domain にまたがれるよう、
spec は AIFormat の `data / feature / interface / setup / test` 分類を維持し、**clause 単位**で
owner / related edge を持つ。document frontmatter の domain refs は索引用 summary であり、
clause edge を上書きしない。

## 未割当・提案・既定 domain

- `unassigned` は正常な明示状態であり、domain node ではない。
- spec/code を根拠なく吸収する catch-all domain を作らない。
- コードがあり spec が無い場合は `code-cluster`、`emergent-domain`、`spec-gap` proposal を作る。
  コードは semantic domain の意味を自動確定しない。
- spec がありコードが無い domain は削除せず、`implementationStatus=missing` として表示する。
- proposal node / edge は approved log と物理的・論理的に分離し、承認前は Kuzu の canonical
  query result に混ぜない。
- builtin の policy example に semantic domain 名を使わない。`state-machine` は対象 project の
  本物の domain 用に予約し、builtin の既定識別子は `transition-guard-example` とする。

## Kuzu と互換 projection

Kuzu、scene manifest、edge JSONL、Web cache は `knowledgeHead`、該当 source revision、
projection schema version を記録し、次の場合に全再構築または read 拒否する。

- log head が一致しない
- projection schema が変わった
- hash chain / source revision 検証に失敗した

projection だけに node / edge を追加してはならない。query で使う transitive subdomain closure、
ancestor 集約、scene activation の逆引きは Kuzu で計算してよいが log へ書き戻さない。
runtime Kuzu session は raw trace の `SceneObservation` を origin 付き overlay として一時投影できるが、
canonical tables/manifest/OKFへ昇格させない。

既存の `.anatomia/domains/*.json`、`spec/data/ontology/*.taxonomy.json`、
`*.domain.json`、`*.screens.json`、`*.scenes.json` は移行中の compatibility projection とする。
新規 write は knowledge transaction を通し、projection writer が必要な旧形式を更新する。

## 関連

- [domain organization](../feature/domain-organization.md)
- [OKF generation](../feature/okf-generation.md)
- [domain discovery workflow](../feature/domain-discovery-workflow.md)
- [scene derivation](../feature/scene-derivation.md)
- [Merkle DAG](./merkle-dag.md)
- [project cache](./project-cache.md)
