# feature: 決定的ドメイン taxonomy レビュー

## 目的

検出済みドメインがコードグラフをどれだけ覆い、互いに分離し、仕様と結び付いているかを
LLM なしで評価する。コード一般の hotspot を見る `review` と分け、taxonomy の境界品質を
対象にする。

実装は [`src/review/domain-review.ts`](../../src/review/domain-review.ts)、人間向け整形は
[`src/review/domain-review-format.ts`](../../src/review/domain-review-format.ts)。

## 評価項目

`DomainReviewReport` は次を返す。

| 項目 | 意味 |
|---|---|
| `coverage` | function/method node のうち 1 domain 以上に claim された割合 |
| `unassigned` | どの domain にも所属しない function/method と `file:line` |
| `cohesion` | domain ごとの `internalEdges / (internalEdges + boundaryEdges)` |
| `isolated` | 同じ domain の別 implementor と calls edge で接続しない member |
| `overlap` | 複数 domain に claim された function/method |
| `boundaryDrift` | calls 近傍の多数 domain と現在 assignment が一致しない member |
| `specIntegrity` | `specRefs` を宣言した domain に spec-linked implementor が 1 件もない状態 |

planned `DomainReviewReport` は既存指標を維持し、次も返す。

| 項目 | 意味 |
|---|---|
| `implementationGap` | approved spec domain に owner CodeSymbol が無い状態 |
| `codeOnly` | owner/spec relation を持たない code cluster |
| `hierarchyIntegrity` | cycle、dangling parent、multiple parent、aggregate への直接 assignment |
| `assignmentStaleness` | CodeSymbol revision と承認時 evidence の不一致 |
| `specRevisionDrift` | domain/spec edge が参照する authored OKF revision の不一致 |
| `contradiction` | spec boundary と code assignment evidence の明示的な衝突 |

planned state の semantic owner は最大 1 なので、現行の `overlap` をそのまま 1 指標にはしない。

- `legacyOverlap`: 複数の legacy DomainDef が同じ symbol を claim する migration input
- `proposalConflict`: 未承認の複数 assignment 候補
- `ownerCardinalityViolation`: approved log が壊れて owner edge が複数ある fail-fast error
- `sharedUsage`: `domain-uses-code` が複数ある正常状態。overlap error ではない

`summary` は cap 前の真の件数を保持し、詳細配列は既定 50 件まで。cohesion の分母となる edge が
無い domain は `null`。implementor が 1 件未満の domain では isolated member を出さない。

boundary drift は決定的 label propagation を既定 10 round 行い、現在 domain と提案 domain、
domain 別 vote 数を evidence として返す。実装は
[`src/review/boundary.ts`](../../src/review/boundary.ts) で、自動で assignment は変更しない。
追加項目も自動修正せず、[`domain-organization.md`](./domain-organization.md) の
assign/move/unassign/split/merge proposal へ evidence を渡す。

## CLI

```text
anatomia domain-review [--repo <path> | --project <id>] [--json] [--by-layer]
```

- `--project` では登録 project の `ontologyDir`（未設定なら repo の既定 domains dir）から
  editable definitions を読み、`specRefs` integrity も検査する。
- `--repo` の単発解析では repo の既定 domains dir を読む。
- `--json` は `DomainReviewReport`、無指定時は coverage summary と domain 別 edge、isolated、
  unassigned、overlap、boundary drift、spec integrity を表示する。

## 層ごとのレビュー（`--by-layer`、A-9）

taxonomy 全体の指標だけでは「どの**層**が薄いか」が分からない。`--by-layer` は同じ
決定的な数値を層ごとに集計し直す。

- 層は `.anatomia/layers.json` の glob（無ければ組み込みの依存成果物ルール）で
  **パスから**決める。どの規則にも当たらない関数は `(unclassified)` に入る
- ドメインは implementor が最も多い層に属させる。同数のときは層名の辞書順で決める
- 層ごとに coverage / 未分類 / 凝集（implementor 重み付き平均）/ 層宣言に反する依存の
  辺数を出す
- **Revisor 所見も層単位**で出す（被覆が薄い・未分類が多い・違反依存がある・凝集が低い）
- 出力順は「宣言された層順 → それ以外は名前順 → `(unclassified)` は最後」で決定的
- 層宣言が無いリポでも組み込みの層順で集計できる
- **gate ではなく lens**。exit code は 0 のまま

`--json` では `DomainReviewReport` に `byLayer` を足して返す。

## UX 直結ドメインの強調（A-10）

`domain-review` は UX 直結ドメイン（[domain-dual-layer.md](./domain-dual-layer.md)）を
`uxCritical` として印を付け、所見で強調する。対応は承認済み `domain-owns-code` を経由して
求め、名前一致では引き継がない。強調まで（block へは昇格させない）。

## 用語の境界

- **unassigned** は domain membership が無いこと。
- **isolated** は domain には所属するが、同じ domain 内の calls 接続が無いこと。
- **boundary drift** は calls 近傍の多数決との不一致であり、誤所属の確定ではない。
- external entrypoint や dynamic dispatch は静的 calls graph に現れないことがあるため、
  isolated / drift は人間が evidence を確認する。
- **spec-only** は異常ではなく実装 gap、**code-only** は自動 domain ではなく spec-gap 候補。
- hierarchy integrity は semantic tree の検査であり、directory/layer/subscene の tree を混ぜない。

## 関連

- [ドメイン検出](./domain-detection.md)
- [ドメイン authoring](./domain-authoring.md)
- [人間承認付きドメイン発見](./domain-discovery-workflow.md)
- [コード構造レビュー](./code-review.md)
- [domain / scene knowledge log](../data/domain-knowledge-log.md)
