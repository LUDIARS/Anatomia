---
title: Anatomia domain organization
type: feature
service: anatomia
domain: domain-modeling
status: implemented
tags:
  - domain
  - subdomain
  - assignment
  - review
x-anatomia:
  kind: domain-organization
---

# feature: domain organization

## 目的と状態

仕様から domain の意味と階層を起こし、その後にコードを精査・割当し、仕様とコードの乖離を
補正するワークフローと整理 UI の implemented contract。永続形式は
[`../data/domain-knowledge-log.md`](../data/domain-knowledge-log.md)、OKF の解析・生成規約は
[`okf-generation.md`](./okf-generation.md) を参照する。
実装は [`../../TASKS.md`](../../TASKS.md) の T56-T62 と
[`../../docs/plan-okf-domain-scene-flow.md`](../../docs/plan-okf-domain-scene-flow.md) で管理する。

## 権威と分離

- domain の purpose / boundary / hierarchy は human-approved specification が決める。
- code は、承認済み domain をどの symbol が実装するかの evidence であり、意味を逆決定しない。
- code だけに存在するまとまりは `emergent-domain` / `spec-gap` proposal になる。
- spec だけに存在する domain は正当であり、実装 0 件でも削除しない。
- scene は runtime / experience context、domain は semantic responsibility であり直交する。
- architectural layer、cross-cutting concern、module directory は domain hierarchy と別軸。

仕様書の分類は AIFormat の `data / feature / interface / setup / test` を維持する。
domain ごとに文書を分割・移動することは必須にせず、SpecClause edge で横断的に整理する。

## domain model

Domain:

- immutable `id`
- display `name`
- purpose / responsibilities
- in-scope / out-of-scope boundary
- `assignable: boolean`
- status / source OKF revision
- optional layer / concerns / rules / aliases

`subdomain-of` は **child → parent** の explicit edge。初期契約では child の parent は最大 1、
cycle と dangling parent を禁止し、transitive edge は保存しない。root / aggregate domain は
`assignable=false` にでき、CodeSymbol を直接所有しない。

複数 parent が欲しく見える関係は、semantic hierarchy でなく dependency / related / concern の
可能性を UI が提示する。scene の subscene edge を domain の subdomain edge と共有しない。

## 「配置」の単位

domain への配置は directory の移動ではなく、stable entity 間の logical relation として定義する。

- spec は document 全体でなく `SpecClause` を単位に、owner 最大 1 + related 0..n。
- code は file 全体でなく `CodeSymbol` を単位に、semantic owner 最大 1 + consumer/related 0..n。
- file / document は UI の集約単位であり、異なる owner が混在できる。
- 物理 path は evidence / architecture rule であって identity ではない。
- `move` action は owner edge の変更。source file を実際に移動する refactor は別 proposal とする。

これにより「仕様書を domain ベースのフォルダへ並べ替える」ことと「仕様を domain へ割り当てる」
ことを分離する。後者は必須、前者は任意である。

## 目標フロー

```text
authored specification OKF
  -> structured SpecClause parse
  -> spec-only Domain / subdomain proposals
  -> human edit + Gate A
  -> approved domain OKF + knowledge transaction
  -> code / asset analysis
  -> assignment actions + evidence
  -> code-only clusters + drift report
  -> existing-domain assignment: Gate B
  -> new/split/merged domain: authored OKF supplement + Gate A/C
  -> atomic knowledge transaction
  -> taxonomy / DomainDef / Kuzu / generated OKF / Web cache projection
  -> residual re-analysis
```

Gate A までは code module map を semantic domain proposal の入力へ混ぜない。Gate A 後の code
analysis は次の action proposal を返す。

| action | 意味 |
|---|---|
| `assign-existing` | 未割当 CodeSymbol を承認済み domain へ置く |
| `move` | owner domain を変更する |
| `unassign` | 根拠の無い owner edge を外す |
| `split` | domain boundary の分割案を作り、semantic Gate C へ送る。自動適用しない |
| `merge` | 重複 domain の統合案を作り、semantic Gate C へ送る。自動適用しない |
| `propose-domain` | code-only cluster から semantic proposal を作り、authored OKF を補って Gate A へ戻す |
| `spec-gap` | 実装意図を説明する仕様が無いことを記録する |
| `abstain` | evidence 不足を明示し未割当に残す |

action は affected stable IDs、before / after、confidence、positive / negative evidence、
analysis snapshot、source revision、proposal ID を持つ。directory や name の一致は evidence であり、
単独で owner を確定しない。

## spec が無いコード

コードを無理に既存 domain または default domain へ入れない。決定的な module / call cohesion /
entrypoint / spec-link gap から cluster を作り、次を proposal として提示する。

- cluster の CodeSymbol と `file:line`
- cohesion / coupling / overlap / call-neighborhood
- 既存 domain へ置ける候補と反証
- 新 domain の仮 purpose / boundary
- 必要な feature spec の draft と未決質問

人が purpose、boundary、acceptance を補足するまで semantic domain として承認できない。
補足後の new domain は Gate B で成立させず、spec-only proposal と同じ Gate A を再通過する。
小さい helper、generated glue、external adapter は `abstain` のままでもよい。

## 乖離の分類と補正

review は少なくとも次を区別する。

- `aligned`
- `spec-only`
- `code-only`
- `wrong-membership`
- `overlap`
- `boundary-drift`
- `stale-spec-link`
- `contradiction`
- `hierarchy-invalid`

spec change は domain semantics / spec edge の proposal を stale にする。code change は code assignment
の evidence を stale にするが、承認済み domain の意味を消さない。補正は必ず新 proposal と diff を
作り、既存 transaction を直接書き換えない。

## Gate と transaction

- propose / inspect / review は repository を書かない。
- apply は `confirmApply=true`、proposal ID、analysis snapshot、expected log head を必須とする。
- Gate A は domain definition / subdomain edge / source SpecClause refs を承認する。
- Gate B は **既存の approved domain** への code assignment と spec-gap の disposition を承認する。
  new domain proposal は authored OKF を補って Gate A へ戻す。
- Gate C は split / merge / hierarchy / boundary 変更を Gate A と同じ semantic approval 条件で扱い、
  更新した authored OKF と影響する spec/code/scene edge を一緒に承認する。既存 domain 間の
  `move` だけなら Gate B で扱える。
- 同じ repository の write は直列化し、human OKF + knowledge JSONL + Git 管理の
  compatibility projections を
  before-image 付きの一単位として rollback する。
- Git 管理 artifact の失敗は transaction 全体を rollback する。Kuzu / Web cache は canonical
  commit 後の local projection なので、失敗時は
  `{ canonicalCommitted: true, projectionsStale: true }` を返し、再構築可能な stale 状態にする。

## 整理 UI

UI は生 JSON と即時 CRUD を並べず、同じ proposal / diff / Gate command 境界を使う。

### Domain canvas

- stable ID、purpose、boundary、assignable、source clauses、implementation status を card 表示
- drag / command による `subdomain-of` edge proposal
- cycle、dangling、multiple parent、aggregate への code assignment を即時 validation
- hierarchy、layer、concern、scene activation を別表示
- collapsed subtree と ancestor 集約。ただし transitive edge を保存しない

### Assignment review

- SpecClause / CodeSymbol の owner 1 件と related / consumer 0..n を別列表示
- direct / inferred、confidence、source anchor、`file:line`、なぜ割り当てたかを表示
- unassigned / ambiguous / proposal-conflict / legacy-overlap / stale を filter
- `assign-existing / move / unassign / abstain` の batch proposal
- domain ごとの coverage だけでなく spec-only domain と code-only gap を表示

### Approval

- before / after graph diff と影響 entity 数
- source revision、analysis snapshot、expected log head
- generated OKF / taxonomy / Kuzu / Web cache への projection preview
- conflict 時は apply せず再解析

scene タブは code-authoritative manifest の inspection / diff / sync 状態を表示する。
scene の add / delete、domain text field、manual override は提供しない。誤りの修正先は code annotation、
detector config、source code、または表示注記 overlay である。

## 現行実装との差

現行には Gate A/B の snapshot・confirm・rollback、read-only suggestion、domain review evidence が
あり再利用する。一方、次は移行対象:

- first draft が spec と module map を同時入力している
- Gate B が新 domain 作成中心で、既存 domain への assign/move/unassign を表せない
- `.anatomia/domains`、taxonomy JSON、DomainDef JSON がそれぞれ正本のように振る舞う
- retune / Adjust が taxonomy と manual scene を直接更新する
- flat taxonomy の sibling 置換で「subdomain」を表している
- spec-only domain を実装 0 件として非表示にする

互換 API は code migration が終わるまで current behavior を返してよいが、新規 write contract は
knowledge transaction に一本化する。

## implemented の範囲

T56-T62 で実装済みなのは proposal 生成 (spec-only / assignment / drift / code-gap)、hierarchy
validation、Gate A/B/C の atomic apply + rollback、`/domain-organization/:id` の review UI である。

| 契約 | 実装 |
|---|---|
| spec-only domain proposal (T56) | `src/knowledge/domain/spec-proposals.ts` |
| hierarchy editor + validator (T57) | `src/knowledge/domain/hierarchy.ts` |
| Gate A: domain OKF + transaction (T58) | `src/knowledge/domain/gate-a.ts`、`src/knowledge/domain/domain-okf.ts` |
| code assignment analyzer (T59) | `src/knowledge/domain/assignments.ts` |
| code-only / spec-gap + drift 分類 (T60) | `src/knowledge/domain/code-gaps.ts`、`src/knowledge/domain/drift.ts` |
| Gate B / semantic Gate C (T61) | `src/knowledge/domain/gate-b.ts`、`src/knowledge/domain/gate-c.ts` |
| 整理 UI と HTTP 境界 (T62) | `src/adapters/web/routes/domain-organization.ts`、`src/adapters/web/domain-organization-page.ts`、`src/knowledge/domain/organization-view.ts` |

`整理 UI` のうち次はまだ実装されておらず、後続 task で埋める。

- drag による `subdomain-of` edge 提案と client-side の即時 validation
  （現行は proposal card の parent select 経由で、validation は Gate A が返す）
- collapsed subtree / ancestor 集約、layer・concern・scene activation の別表示
- assignment の batch proposal と ambiguous / proposal-conflict / legacy-overlap / stale filter
- projection preview（generated OKF / taxonomy / Kuzu / Web cache）と scene タブ
- Gate C の UI 導線（API のみ提供。split/merge proposal は reconciliation endpoint から取得する）

## 関連

- [domain discovery workflow](./domain-discovery-workflow.md)
- [domain authoring](./domain-authoring.md)
- [domain detection](./domain-detection.md)
- [domain review](./domain-review.md)
- [domain retune](./domain-retune.md)
- [scene derivation](./scene-derivation.md)
