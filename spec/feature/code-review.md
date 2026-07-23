# feature: 決定的コード構造レビュー

## 目的

解析済み `AnalysisContext` から、LLM やネットワークを使わず再現可能なコード構造レポートを
作る。レビュー対象を変更せず、各指摘を repo-relative の `file:line` と Anchor ID へ戻せる
形で提示する。

実装は [`src/review/build.ts`](../../src/review/build.ts)、人間向け整形は
[`src/review/format.ts`](../../src/review/format.ts)。

## 入力と出力

入力は、コードグラフ、ドメイン検出結果、仕様 clause/link を含む `AnalysisContext`。
出力 `ReviewReport` は次を持つ。

| 項目 | 判定 |
|---|---|
| `violations` | domain rule の違反を rule、severity、evidence、locations で列挙 |
| `hotspots` | fan-in、fan-out、coupling、cyclomatic の大きい関数を上位順で列挙 |
| `cycles` | calls graph の `NoCycle` 違反グループ |
| `structuralDup` | path を除いた structural hash が同じ named function の複製 |
| `domainCoupling` | 異なる primary domain 間を跨ぐ edge 数 |
| `orphans` | static caller が無い（`fanIn === 0`）関数。`main` は除外 |
| `specGaps` | spec が存在するプロジェクトで、どの spec clause にも link されない source file |

`summary` は cap 前の真の件数を返す。`hotspots` は既定 20 件、`orphans` と `specGaps` の
表示配列は既定 50 件までだが、件数自体は切り詰めない。

## CLI

```text
anatomia review [--repo <path> | --project <id>] [--json]
                [--baseline <file>] [--write-baseline <file>]
```

- `--json` は `ReviewReport` を返し、無指定時は人間向け summary と section を表示する。
- `--write-baseline` は現在の violation / duplication / cycle / domain coupling の fingerprint を
  JSON に保存し、レポート本文は出さない。
- `--baseline` は一致する既知 fingerprint を結果から除外する。読めない、または壊れた
  baseline は空 baseline として扱う。

baseline は既知指摘を隠すためのもので、`hotspots`、`orphans`、`specGaps` は抑制しない。
baseline の fingerprint、load/save、filter 契約は
[`src/review/baseline.ts`](../../src/review/baseline.ts) が実装する。

## 制約

- `specGaps` は file-level linkage の欠落であり、機能仕様が意味的に十分かまでは保証しない。
- fan-in 0 は外部 entrypoint や dynamic dispatch も含み得るため、dead code と同義ではない。
- cycle 検出には自己呼び出しも含まれ得る。修正要否は evidence を読んで判断する。
- 本機能は検出専用で、コード、spec、baseline を自動修正しない（baseline 書き出しを明示した
  場合を除く）。

## 関連

- [静的解析](./static-analysis.md)
- [仕様リンク](./spec-linkage.md)
- [verify gates](./verify-gates.md)
- [ドメインレビュー](./domain-review.md)
