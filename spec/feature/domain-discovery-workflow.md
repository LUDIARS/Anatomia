# feature: 人間承認付きドメイン発見ワークフロー

## 目的

仕様と実装の両側からプロジェクト固有のドメインを発見する。ただし LLM と静的解析は
**候補を提案するだけ**であり、人間が確認する前に ontology / taxonomy / feature spec を
変更しない。既存の `domains suggest`、domain authoring、domain review、module 層、retune の
部品を、次の順序と停止条件で結ぶ。

1. spec から LLM でドメイン候補を検索する。
2. 人間が候補を追加・削除・編集し、Gate A で承認する。
3. 承認済みドメインに属さない機能と関数を決定的に調査する。
4. 大きい孤立機能だけを LLM で詳細調査し、ドメイン + feature spec の候補にする。
5. 人間が仕様へ補足し、Gate B で承認した候補だけを成立させる。
6. 再解析後もどこにも属さない関数を `file:line` で残す。

## 用語

- **未所属関数 (unassigned function)**: 現在承認されているどのドメインの
  `implementors` にも含まれない function / method。
- **ドメイン内孤立 (isolated member)**: ドメインには所属するが、同じドメインの別関数と
  calls 辺で接続しない関数。domain review の既存指標であり、未所属とは別。
- **未解決呼び出し (unresolved call)**: 呼び先を静的に解決できなかった calls evidence。
  dynamic dispatch や外部 entrypoint を含み得るため、未所属・到達不能とは同一視しない。
- **孤立機能 (orphan feature group)**: 未所属関数を既存 module 層の決定的境界
  （既定は source directory、任意で class）へ集約したもの。
- **権威データ**: 検出が消費する ontology、committed taxonomy、承認済み feature spec。
- **提案データ**: Gate A / Gate B の前に返す read-only draft。権威データではない。

## 不変条件

1. propose / inspect 操作は権威データを書かない。
2. apply は `confirmApply=true` と、提案時の解析 `snapshotId` を必須とする。
3. 現在の snapshot と一致しない提案は stale として拒否し、再提案を要求する。
4. LLM の返した symbol / path / line を証拠として信用しない。関数 evidence は解析結果から
   サーバ側で組み立て、repo-relative forward-slash path + **1 始まりの宣言開始行**で返す。
5. 孤立機能は全件を無理にドメイン化しない。既定では 3 関数以上の group だけが候補で、
   閾値未満・却下・未選択の関数は残余一覧に残る。
6. 自動生成 spec は draft。人間の補足と Gate B の確認前には保存しない。
7. 既存 feature spec を暗黙に上書きしない。同名 path が存在して内容が異なる場合は
   fail-fast し、人間に merge / rename を求める。
8. 入力順にかかわらず group、function、proposal の順序と content ID は安定する。
9. Gate A の承認状態は `.anatomia/domain-discovery-gate.json` に ontology snapshot として
   保存する。未承認または承認後に ontology が変わった状態では step 3 以降を `409` で止める。
10. Gate A / B で人間が承認した definitions は manual/locked とし、後続の自動 reconstruct が
    人間の調整を上書きしない。
11. Gate A は repository 単位で直列化し、lock 内で最新 snapshot を再計算する。
    domain 群または Gate marker の保存が途中で失敗した場合は全 before-image を復元する。
    retune / 手書き由来の非canonical filename や複数定義JSONは元documentをin-place更新し、
    canonical filenameへ複製しない。
12. Gate B も同じ lock 内で最新 analysis/spec snapshot を再取得し、同一 groupId の二重承認を拒否する。
    domain/spec/Gate marker は一単位として rollback し、部分適用を成功として返さない。

## 状態遷移

```text
spec + code snapshot
  -> spec domain proposals (read-only)
  -> human edit/add/drop
  -> Gate A: explicit apply
  -> deterministic unassigned scan
  -> large orphan feature proposals + generated spec drafts (read-only, LLM)
  -> human select/edit/supplement
  -> Gate B: explicit apply
  -> re-analyze
  -> residual unassigned function report
```

Gate A より前に orphan scan へ進めない。Gate B より前に孤立群由来の DomainDef と feature
spec を保存しない。既存の `retune` は taxonomy 全体を再生成する明示的な保守操作として残すが、
このワークフローからは呼ばない（retune は leftover 全件を登録するため目的が異なる）。

## 提案モデル

### spec 起点

`DomainDraftProposal` は次を返す。

- `snapshotId`: spec clause 内容 + function Anchor ID + source path + 現在の ontology の正準ハッシュ。
- `proposalId`: snapshot + 候補内容の正準ハッシュ。
- `drafts`: `DomainDraft[]`。UI / API 呼び出し側が編集・追加・削除できる。
- `preview`: 現在の editable definitions と reconcile した場合の added / updated / preserved。

Gate A は編集後の `drafts` と `overrideNames` を受ける。既存 manual / locked domain を変更する
場合は対象名を domain ごとに明示し、global force は許可しない。未指定の locked domain へ変更が
含まれる場合は fail-fast する。承認された baseline 全体を manual / fully locked として保存する。

### 孤立群起点

`OrphanInvestigation` は全未所属関数、全 module group、候補 group、閾値未満の残余関数を返す。
各関数は少なくとも
`{ anchor, name, signature, signatureShape, enclosingType, file, line, endLine, reason }` を持つ。

`OrphanDomainProposal` は候補 group ごとに次を持つ。

- proposal / snapshot / group の content ID。
- 解析器が確定した全関数 evidence (`file:line`)。
- LLM が提案した domain name / purpose / responsibilities / boundary。
- Gate B 適用時に deterministic evidence から作る exact
  `file + name + normalized qualified signature shape` membership filter。
- 自動生成 feature spec draft（責務、範囲内・範囲外、受入条件、依存、仮定、未決質問）。
- 人間が記入する `humanSupplement`。

LLM は意味の説明に使い、関数所属・path・line の真実は変更できない。proposal 表示用の
directory pattern は Gate B で権威化せず、適用時に各 evidence の
`file + name + signatureShape` conjunction へ再構成する。`signatureShape` は既存の
`normalizeSignatureShape` により namespace / class / function name / parameter type / return type を
正規化し、空白とparameter名を含めない。Anchor ID は snapshot / evidence の stale 検証にだけ使い、
永続 membership には保存しない。これにより overload / 同名 method、同一 file の別 class、
free function、別 file、同じ directory の既所属関数、小さい残余群を巻き込まず、body・整形・
parameter名だけの変更で Anchor ID や生signatureが変わっても所属は維持する。qualified scope / name /
parameter type / return type が変わった場合は境界変更として再承認対象にする。

## 大きい group の判定

既定 module 粒度は directory。group の品質表示には既存 module evaluation の cohesion / coupling
を使う。候補化条件は `functionCount >= minGroupFunctions`（既定 3）。閾値は API で明示的に
変更可能だが、0 や負数は拒否する。低 cohesion、overlap、boundary drift は人間判断の evidence
として表示し、自動承認理由にはしない。

## Web API

登録プロジェクトでは次の API を提供する。

| メソッド | パス | 副作用 |
|---|---|---|
| POST | `/api/projects/:id/flow/draft` | spec 起点候補を返すだけ |
| POST | `/api/projects/:id/flow/apply` | Gate A。確認 + snapshot 一致時だけ保存 |
| GET | `/api/projects/:id/flow/orphans` | 未所属関数と group を調査するだけ |
| POST | `/api/projects/:id/flow/orphan-proposals` | 大きい group の domain/spec 候補を返すだけ |
| POST | `/api/projects/:id/flow/orphan-apply` | Gate B。選択候補 + 人間補足を保存し再解析 |

`POST /api/flow/draft`（repo/spec path 直接指定）も proposal-only とする。権威データを書きたい
呼び出しは必ず apply API を使う。旧 CLI の `domains suggest` は同じ read-only 契約を維持する。

## 仕様生成と保存

Gate B で承認した domain ごとに `spec/feature/domain-<slug>.md` を作る。内容は次を含む。

- 目的 / ユーザへの約束
- 責務
- 範囲内 / 範囲外
- 主な関数 evidence（全件 `file:line`）
- 依存と境界
- 受入条件
- LLM が置いた仮定と未決質問
- 人間の補足
- origin proposal / group / analysis snapshot の provenance

`humanSupplement` は空白不可とする。LLM draft だけでは Gate B を通過できない。

残余一覧は Gate B 後の**再解析結果**から作る。候補化前の一覧を使い回さない。

## 現行実装から継承する優れた点

- `domains suggest` の read-only 境界。
- EditableDomainDef の manual / locked field 保全。
- `domain-organization` の `apply` + `confirmApply` 二重ゲート。
- domain review の coverage / unassigned / isolated / overlap / cohesion / boundary drift と
  `file:line` evidence。
- module 層の決定的集約と評価。
- content-addressed cache と安定 ID。snapshot の stale 検出へそのまま利用できる。
