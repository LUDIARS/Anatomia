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

`summary` は cap 前の真の件数を保持し、詳細配列は既定 50 件まで。cohesion の分母となる edge が
無い domain は `null`。implementor が 1 件未満の domain では isolated member を出さない。

boundary drift は決定的 label propagation を既定 10 round 行い、現在 domain と提案 domain、
domain 別 vote 数を evidence として返す。実装は
[`src/review/boundary.ts`](../../src/review/boundary.ts) で、自動で assignment は変更しない。

## CLI

```text
anatomia domain-review [--repo <path> | --project <id>] [--json]
```

- `--project` では登録 project の `ontologyDir`（未設定なら repo の既定 domains dir）から
  editable definitions を読み、`specRefs` integrity も検査する。
- `--repo` の単発解析では repo の既定 domains dir を読む。
- `--json` は `DomainReviewReport`、無指定時は coverage summary と domain 別 edge、isolated、
  unassigned、overlap、boundary drift、spec integrity を表示する。

## 用語の境界

- **unassigned** は domain membership が無いこと。
- **isolated** は domain には所属するが、同じ domain 内の calls 接続が無いこと。
- **boundary drift** は calls 近傍の多数決との不一致であり、誤所属の確定ではない。
- external entrypoint や dynamic dispatch は静的 calls graph に現れないことがあるため、
  isolated / drift は人間が evidence を確認する。

## 関連

- [ドメイン検出](./domain-detection.md)
- [ドメイン authoring](./domain-authoring.md)
- [人間承認付きドメイン発見](./domain-discovery-workflow.md)
- [コード構造レビュー](./code-review.md)
