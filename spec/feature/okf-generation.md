---
title: Anatomia OKF ingestion and generation
type: feature
service: anatomia
domain: knowledge-model
status: planned
tags:
  - okf
  - generated-artifact
  - provenance
x-anatomia:
  kind: okf-generation
---

# feature: OKF 解析・生成

## 目的と状態

Anatomia が読む human-authored OKF と、Anatomia が書く generated OKF の境界を固定する
target contract。domain と scene の feature は「何を生成するか」を定め、本仕様は
「OKF をどう解析・描画・更新するか」だけを所有する。
実装は [`../../TASKS.md`](../../TASKS.md) の T51-T54/T58/T65 と
[`../../docs/plan-okf-domain-scene-flow.md`](../../docs/plan-okf-domain-scene-flow.md) で管理する。

2026-08-04 時点で T51-T68 の foundation、domain authoring workflow、scene projection workflow、adapter migration は実装済みである。`src/knowledge/` が stable ID、
frontmatter + semantic-unit parser、canonical transaction log、ownership manifest writer、Kuzu と
legacy compatibility projection を所有する。T69 の executable integration fixture と実測 baseline は未完了である。

## 文書の役割

| role | 例 | 編集権威 | Anatomia の動作 |
|---|---|---|---|
| authored specification | read-only `specDirs[]` の `feature/*.md` 等 | 人 | parse のみ。本文を無断変更しない |
| authored domain definition | `<knowledgeWriteRoot>/data/domains/*.md` | 人 + Gate | proposal / diff を経て作成・更新 |
| generated scene projection | `<knowledgeWriteRoot>/data/generated/anatomia/scenes/*.md` | code / asset | explicit sync で全体を決定的再生成 |
| generated index / manifest | generated subtree | generator | ownership manifest の範囲だけ更新 |
| manual scene annotation | `<knowledgeWriteRoot>/data/scene-annotations/*.md` | 人 | 表示名・注記だけ merge |

domain definition は `type: data` + `x-anatomia.kind: domain`、scene projection は
`type: data` + `x-anatomia.kind: scene` を使う。AIFormat に存在しない `type: scene` や
`type: domain` を追加しない。一般の feature spec は `type: feature` のままにし、domain ごとの
物理フォルダへ移動しない。

## Anatomia OKF profile

AIFormat の共通 `domain:` は document 全体の検索用 taxonomy tag として維持する。stable entity ID、
複数 domain refs、provenance は namespaced extension に置く。

`x-anatomia.kind` は open namespace だが、loader routing に使う予約値は次の 4 つ。

| kind | loader |
|---|---|
| `specification` または kind 無し | authored SpecClause parser |
| `domain` | approved-domain loader。新 domain proposal の入力へ戻さない |
| `scene` | generated scene loader。authored SpecClause parser へ渡さない |
| `scene-annotation` | annotation loader。domain/spec proposal の入力へ渡さない |

`domain-knowledge-log`、`domain-organization`、`okf-generation` のような追加 kind は metadata namespace
として許可し、専用 handler が無ければ authored specification として解析する。
`x-anatomia.generated: true` は kind と独立した正式 marker である。

human-authored domain definition:

```yaml
---
type: data
title: Combat resolution domain
service: example-game
domain: combat
status: planned
x-anatomia:
  kind: domain
  id: domain:example-game/combat-resolution
  assignable: true
  parent-id: domain:example-game/gameplay
  source-clause-ids:
    - spec:combat/rules#resolve-hit
---
```

一般の authored specification（document-level summary。正確な owner は clause edge）:

```yaml
---
type: feature
title: Combat hit resolution
service: example-game
domain: combat
status: implemented
x-anatomia:
  kind: specification
  id: spec:combat/hit-resolution
  domain-refs:
    - domain:example-game/combat-resolution
---
```

generated scene projection:

```yaml
---
type: data
title: Battle HUD scene
service: example-game
domain: combat
status: implemented
x-anatomia:
  kind: scene
  id: scene:example-game/battle-hud
  generated: true
  source-revision: git:0123456789abcdef
  source-fingerprint: sha256:...
  generator-schema: 1
---
```

`parent-id` と `domain-refs` は可読 authoring hint。承認済みの cardinality、revision、edge history は
knowledge transaction が保持し、frontmatter と矛盾すれば apply を止める。

## authored OKF の解析

parser は Markdown を単なる heading chunk にせず、次の二段階で処理する。

1. frontmatter と Markdown AST から document / heading / paragraph / list item /
   table row / definition / code reference を lossless な source range 付きで抽出する。
2. normative modality、明示 ID、domain refs、symbol refs を正規化し、semantic unit ごとに
   `SpecClause` を作る。

精度と再現性の要件:

- heading の下にある複数 list item を一塊に潰さず、受入条件・禁止事項を独立 clause にできる。
- table は header と row の対応を保持する。
- fenced code、path、qualified symbol、`@implements` を本文 token と分離して evidence 化する。
- `must / shall / should / may` および日本語の「必須 / 禁止 / する / できる」を modality として
  保持するが、LLM 推定だけで規範強度を確定しない。
- explicit ID を最優先する。無い clause は document ID + Markdown AST structural address
  （heading ancestry + semantic-unit kind + sibling index）から provisional ID を決定的生成し、
  normalized content hash は revision evidence にする。承認時に explicit ID を提案する。
- parser output は source revision、repo-relative path、1 始まりの line range、抽出法を持つ。
- explicit → structural → semantic の三段 linker を混ぜず、confidence と evidence を保持する。
- spec-only domain proposal の段階へ module map、directory name、code symbol を混入させない。

## domain OKF

仕様書からの自動解析は、直接 domain を成立させず `DomainProposal` を返す。proposal は少なくとも
次を含む。

- immutable candidate ID
- name / purpose / responsibilities
- in-scope / out-of-scope boundary
- source SpecClause IDs と source revision
- parent candidate / relation proposal
- `assignable`（aggregate/root は false）
- assumptions / unresolved questions
- parser / LLM / human evidence と confidence

Gate A の承認後にだけ `<knowledgeWriteRoot>/data/domains/*.md` を作成または更新し、knowledge transaction へ
同じ source revision を記録する。既存文書と競合する場合は merge / rename を要求し、
path や本文を暗黙上書きしない。

feature spec には document-level summary として domain refs を書いてよいが、正確な割当は
[`../data/domain-knowledge-log.md`](../data/domain-knowledge-log.md) の clause edge に置く。
これにより 1 文書 1 domain を強制せず、同じ clause の owner 1 件 + related 0..n を表現する。

## generated scene OKF

scene は code / asset を正本として自動割当する。generated OKF は人が編集する source ではなく、
canonical scene manifest の可読 projection である。

各 scene document は少なくとも次を持つ。

- stable scene ID と表示 label
- `type: data`、`x-anatomia.kind: scene`、generated marker
- source revision / source fingerprint / generator schema
- entry、element、transition の可読 summary
- direct / reached CodeSymbol の summary と完全 edge JSONL への参照
- derived active Domain IDs
- reached CodeSymbol の spec link から導出した SpecClause IDs
- definition origin（static-code / engine-asset / route / workflow）と evidence

関数・element が多い scene で全 edge を Markdown に複製しない。完全な relation は
`scene-edges.jsonl` と Kuzu に置き、OKF はレビュー可能な summary + refs を持つ。
scene→spec は scene→domain→全 domain code の近道を使わず、実際に reached した code の
spec link だけから導出する。
raw trace / `SceneObservation` は user data の local overlay であり、generated scene OKF へ書かない。

## 決定的な描画

- 同一 canonical records + renderer schema から byte-identical な UTF-8/LF を出す。
- wall-clock timestamp、絶対 path、処理順依存の値を本文へ入れない。
- entity、edge、frontmatter key は仕様で定めた stable order にする。
- source revision、content fingerprint、generator schema は入れる。
- 既存 bytes と同じなら write しない。
- GET / query / Web 表示の read route は生成物を書かない。repository への反映は
  `sync` / Gate apply の明示 write command に限定する。

## ownership manifest と原子的更新

generator は resolved
`<knowledgeWriteRoot>/data/generated/anatomia/manifest.json` が所有する相対 path だけを更新する。

1. source fingerprint と canonical records を固定する。
2. staging directory に全 output を描画する。
3. manifest に path、content hash、entity ID、`knowledgeHead`、source revision、
   projection/generator schema を記録する。
4. 既存 head / source revision を再検証する。
5. generated set と manifest を同一 lock 内で置換する。
6. 旧 manifest が所有し、新 manifest に無い stale file だけを削除する。

human-authored file、manifest 未登録 file、annotation overlay は削除・上書きしない。途中失敗時は
旧 set を維持し、部分更新を成功として返さない。

## 自己入力ループの禁止

loader は real path と namespaced metadata で route する。

- resolved generated root 配下 **または** `x-anatomia.generated: true` の文書は、場所を問わず
  authored SpecClause parser、domain proposal、retune input、source fingerprint から除外する。
- resolved domain root 配下は `x-anatomia.kind: domain` を必須とし approved-domain loader だけが読む。
- resolved annotation root 配下は `x-anatomia.kind: scene-annotation` を必須とし annotation loader だけが読む。
- domain / annotation root 内で kind が欠ける・違う文書は generic parser へ落とさず fail-fast する。

```text
authored spec/code fingerprint
  -> analyze/reconcile
  -> canonical records
  -> generated outputs
       X generic spec parse
       X authored-source fingerprint
```

generated output は scene / OKF 専用 loader だけが読む。source fingerprint と output fingerprint を
分け、scene OKF を書いたことで次回解析の入力 fingerprint が変わる feedback loop を作らない。

## manual annotation

scene annotation は scene ID を key にした非権威 overlay とし、表示 label、説明、review note だけを
許可する。identity、entry、composition、transition、code/domain/spec assignment を上書きできない。
不正な ID や source revision の注記は dangling / stale として表示する。

## 関連

- [domain / scene knowledge log](../data/domain-knowledge-log.md)
- [domain organization](./domain-organization.md)
- [scene derivation](./scene-derivation.md)
- [spec linkage](./spec-linkage.md)
- [spec source config](./spec-source-config.md)
