# OKF domain / scene flow implementation plan

## 目的

Anatomia の domain を仕様起点で整理し、その後にコードを精査・割当・補正する。scene は
code / asset を正本として全自動導出し、同じ knowledge model、CLI、MCP、Web UI から読む。

この文書は実装計画であり、永続契約は次を正本とする。

- [`../spec/data/domain-knowledge-log.md`](../spec/data/domain-knowledge-log.md)
- [`../spec/feature/okf-generation.md`](../spec/feature/okf-generation.md)
- [`../spec/feature/domain-organization.md`](../spec/feature/domain-organization.md)

現行 scene 実装と移行差分は
[`../spec/feature/scene-derivation.md`](../spec/feature/scene-derivation.md) に記録する。

## 現状評価

目標フローの一部は存在するが、全体としては未完成。

| 領域 | 現在使えるもの | 差分 |
|---|---|---|
| spec proposal | heading parse、LLM draft、no-LLM seed | spec と module map を同時入力し、pure spec-first ではない |
| human Gate | Gate A/B、snapshot、confirm、rollback | canonical JSONL head と OKF revision を検証しない |
| code review | unassigned / isolated / overlap / drift evidence | assign-existing / move / unassign / abstain が無い |
| domain storage | ontologyDir、taxonomy、DomainDef | authoring / machine / projection の正本が三重化 |
| subdomain | retune の split | flat sibling 置換で typed edge / cycle validation が無い |
| scene | screen seed、call BFS、transition、trace phase | exact anchors / elements / provenance / spec refs を保持しない |
| scene storage | derived artifact + manual scenes merge | manual が ID 衝突で勝ち、code-authoritative と衝突 |
| OKF | Markdown spec parser | OKF profile、writer、generated ownership / exclusion が無い |
| query | in-memory graph + Kuzu の一部 | Domain / Scene / hierarchy / assignment projection が無い |
| UI | flow + Adjust + Scenes | Gate、生 JSON、直接 CRUD、manual scene CRUD が併存 |

したがって正しい実装順は、仕様 domain 起こしの後にコード domain 精査・割当・生成を行う目標と
一致するが、現在は source-of-truth、既存 domain への割当、乖離補正、scene 永続化が不足している。

## 採用する流れ

```text
spec OKF
  -> precise clause parser
  -> spec-only domain / hierarchy proposals
  -> Gate A
  -> domain OKF + knowledge JSONL
  -> code analysis and assignment proposals
  -> Gate B/C
  -> knowledge JSONL
  -> compatibility projections + Kuzu

code / assets
  -> scene detectors + exact reachability
  -> canonical scene records
  -> explicit sync transaction
  -> generated scene OKF / edge JSONL
  -> Kuzu / CLI / MCP / Web read models
```

code-only project は後半から開始し、code cluster と spec gap を proposal にする。仕様の代わりに
directory 名を domain の意味として自動承認しない。spec-only project は Gate A まで進められ、
domain を `implementationStatus=missing` のまま正しく保持する。

## 実装タスク

### G11: knowledge / OKF foundation

#### T50 neutral builtin policy identity

- builtin の semantic default を廃止し、`state-machine` を project domain 用に予約する。
- builtin example の識別子を `transition-guard-example` にする。
- domain 未解決時は `unassigned` を返す。

受入: builtin を有効にしても project に `state-machine` domain が存在したことにならず、本物の
同名 domain と衝突しない。

#### T51 Anatomia OKF profile and stable identity

- AIFormat six types 内で routing kind と open `x-anatomia.kind` namespace を定義する。
- Domain / SpecDocument / SpecClause / CodeSymbol / Scene / SceneElement ID codec と alias を分離する。
- explicit ID と provisional ID を区別する。
- read-only `specDirs[]` と単一 `knowledgeWriteRoot` の決定規則を定義する。

受入: rename、body edit、display label 変更の identity 挙動が fixture で固定される。

#### T52 precise OKF spec parser

- frontmatter + Markdown AST の二段 parser。
- paragraph / list / table / definition / code ref を source range 付き clause にする。
- modality、explicit ID、domain refs、symbol refs、provenance を保持する。
- resolved generated root 配下 **または** `x-anatomia.generated: true` を authored input から除外し、
  domain/annotation subtree を専用 loader へ route する。

受入: 単純 heading chunk より clause boundary / explicit link precision が改善し、同一入力で同一 ID。

#### T53 canonical knowledge transaction log

- canonical JSONL、hash chain、expected head、atomic append、replay、conflict。
- node / edge schema と cardinality / hierarchy validation。
- proposal store と approved log を分離する。

受入: partial write、bad line、head conflict、cycle、dangling edge を fail-fast し、transaction rollback
後に byte-identical な元 log を保つ。

#### T54 deterministic generated artifact writer

- generated ownership manifest、write-if-changed、atomic set replacement。
- stale file は manifest-owned path だけ削除する。
- source/output fingerprint 分離と self-ingestion exclusion。

受入: 同一入力の再実行で Git diff が出ず、人の文書を上書きせず、削除 scene の owned file だけ消える。

#### T55 Kuzu and compatibility projections

- knowledge log を Domain / SpecClause / CodeSymbol / Scene / SceneElement と typed edge へ投影する。
- subdomain closure と scene/domain/spec の逆引きを query interface で公開する。
- taxonomy / DomainDef / screens / scenes JSON を compatibility writer に降格する。

受入: Kuzu を削除して log から同じ query result を再構築でき、Kuzu-only write が存在しない。

### G12: spec → domain → code organization

#### T56 spec-only domain proposal generator

- code/module map を入力しない spec-only first pass。
- purpose / responsibilities / boundary / assignable / source clauses / parent proposal を返す。
- deterministic seed と LLM enrichment を evidence 別に保持する。

受入: code 0 件でも domain proposal を生成でき、code path が name/purpose の根拠に混ざらない。

#### T57 domain hierarchy editor and validator

- immutable ID と child→parent `subdomain-of` edge。
- max-one-parent、acyclic、dangling、aggregate assignment validation。
- layer / concern / related relation を hierarchy から分離する。

受入: cycle / multiple parent を apply 前に拒否し、parent rename / move で child ID が変わらない。

#### T58 Gate A OKF + log persistence

- proposal diff、source revision、analysis snapshot、expected log head。
- domain OKF と knowledge transaction の一括 write / rollback。
- existing human file の merge conflict を fail-fast。

受入: spec change 後の stale proposal を拒否し、失敗時に OKF / log の部分適用が残らない。

#### T59 code assignment analyzer and actions

- approved domains に対する exact CodeSymbol evidence を作る。
- assign-existing / move / unassign / abstain を返す。
- owner 1 件、consumer/related 0..n を検証する。

受入: overload / same-name / body edit を誤同一視せず、「なぜ割当したか」を source anchor 付きで返す。

#### T60 code-only cluster, spec-gap, and drift reconciliation

- unassigned cluster と既存 domain 候補、反証、cohesion/coupling を提示する。
- emergent-domain / spec-gap / split / merge proposal。
- aligned/spec-only/code-only/wrong-membership/overlap/boundary-drift/stale-link/contradiction を分類する。
- new domain は authored OKF を補う Gate A、split/merge は同等の semantic Gate C へ戻す。

受入: code-only cluster を自動承認せず、小群を default domain に押し込まず residual として残す。

#### T61 Gate B/C workflow orchestrator

- Gate B は既存 domain の assignment、Gate C は Gate A 相当の split/merge/boundary approval とする。
- assignment と semantic boundary 変更をそれぞれ atomic transaction に束ねる。
- OKF / binding / projection の before-image と repository lock。
- apply 後の residual re-analysis。

受入: concurrent head change と二重承認を拒否し、split/merge で dangling scene/spec edge を残さない。

#### T62 domain organization Web UI

- Domain canvas、typed edge editing、assignment evidence、drift filter、approval diff。
- raw JSON、taxonomy direct CRUD、retune direct apply を proposal command へ置換する。
- spec-only domain と unassigned code を同時表示する。

受入: UI の全 write が同じ Gate command を通り、cycle/conflict/partial apply を明示表示する。

### G13: code-authoritative scenes

#### T63 scene source inventory and stable identity

- static code、engine asset、route/workflow を `SceneDefinitionSeed` へ正規化する。
- trace は既存 scene へだけ付く `SceneObservation` に分け、unmatched phase は provisional diagnostic にする。
- native GUID / explicit annotation / route / qualified entry / deterministic fallback の優先順。
- alias / tombstone と source provenance。

受入: detector 順や display label 変更で ID が揺れず、static definition と trace observation を区別する。

#### T64 exact scene graph derivation

- SceneElement、entry、contains、transition、exact direct/reached CodeSymbol を保持する。
- CodeSymbol ownership から active Domain を導出する。
- reached code の spec link からだけ SpecClause relation を導出する。

受入: domain 全体を過大に scene spec へ結ばず、unreachable function に fake scene を与えない。

#### T65 scene knowledge sync and generated OKF

- definition source 由来の canonical scene records だけを `replace-derived-set` transaction で sync。
- scene manifest、edge JSONL、scene OKF を deterministic writer で生成する。
- repository への write は explicit sync、read route は副作用なし。

受入: code/asset の変更だけが scene set を変え、再生成で byte-identical、generated Markdown が
次の spec input/fingerprint に入らない。

#### T66 unified scene consumers and inspection UI

- CLI / MCP / Web / Integral / web-cache を `knowledgeHead` / source revision / schema を検証する
  scene manifest reader へ統一する。
- source anchor、direct/reached、generated/observed、stale、assignment reason を表示する。
- manual scenes JSON は display annotation だけ移行し、identity/edge override を廃止する。

受入: consumer ごとの merge order 差が無く、UI から scene の権威 field を CRUD できない。

### G14: adapters, migration, verification

#### T67 common knowledge application service

- domain/scene command と query を application service に集約する。
- CLI / MCP / Web は同じ validation、revision conflict、rebuild status を返す。

受入: adapter ごとに別の write path / merge rule が存在しない。

#### T68 legacy migration

- `.anatomia/domains`、taxonomy、DomainDef、screens、manual scenes を inventory。
- stable ID を割当て、conflict report と dry-run diff を出す。
- manual scene は許可 field だけ annotation overlay へ移す。

受入: dry-run 無しの破壊移行をせず、元 artifact を保持したまま replay 可能な migration transaction を作る。

#### T69 integration fixtures and quality metrics

- spec-only、code-only、mixed、renamed、hierarchy conflict、scene rename、trace enrichment fixture。
- parser precision/recall、ID stability、assignment evidence、replay determinism、regeneration diff を計測する。
- current/planned spec と adapter documentation を実装完了時に同期する。

受入: end-to-end flow と migration が fixture で再現し、品質値と既知限界を report する。

## 依存順

```text
T50
T51 -> T52
T51 -> T53
T51 -> T54
T53 + T54 -> T55
T52 -> T56 -> T57
T53 + T54 + T57 -> T58 -> T59 -> T60 -> T61 -> T62
T51 -> T63 -> T64
T53 + T54 + T64 -> T65 -> T66
T55 + T61 + T66 -> T67 -> T68 -> T69
```

T52/T53/T54、T56/T63 は file ownership が分離できるため並行実装できる。T62 と T66 は共通 UI
component を使ってよいが、domain write UI と scene read-only UI の責務は分ける。

## ロールアウトと補正可能性

1. reader と dry-run migration を先に入れ、旧 store を書き換えない。
2. dual-read compare で current projection と knowledge query の差を report する。
3. new write を knowledge transaction に切替える。
4. taxonomy / DomainDef / screens / scenes を compatibility projection にする。
5. 全 consumer を共通 reader へ切替える。
6. legacy direct write を削除する。

仕様とコードに乖離があっても、source revision + proposal + before/after edge + Gate transaction が
残るため補正可能である。補正不能になるのは、source revision を持たない direct CRUD、Kuzu-only
write、generated document の手編集を許した場合なので、これらを不変条件で禁止する。
