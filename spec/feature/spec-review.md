# feature: AIFormat 準拠 spec 構造レビュー

## 目的

対象リポジトリの `spec/` が AIFormat の分類規則に沿って配置されているかを、コード解析、
LLM、ネットワーク、Git コマンドなしで決定的に検査する。

実装は [`src/spec-review/review.ts`](../../src/spec-review/review.ts)、表示は
[`src/spec-review/format.ts`](../../src/spec-review/format.ts)。参照基準は対象 repo に同梱された
`lib/aiformat` の `FORMAT_SPEC.md`、`common/REVIEW_QUALITY.md`、`REVIEW.md`。

## 検査対象

読み取る対象は `spec/` ツリーとルート `.gitignore`。検出する finding は次の 7 種類。

| kind | 条件 | severity |
|---|---|---|
| `MISSING_SPEC` | `spec/` が存在しない | High |
| `NONCANONICAL_DIR` | `data/faq/feature/interface/plan/setup/test` 以外の分類 dir | High |
| `STRAY_FILE` | `spec/` 直下の `README.md` / `index.md` 以外の file | Medium |
| `GITIGNORE_DATA` | 未 anchor の `data/` ignore が `spec/data/` も除外する | High |
| `MISSING_CATEGORY` | 評価対象 5 分類の directory が無い | Low |
| `EMPTY_CATEGORY` | index 以外の Markdown が無い評価対象分類 | Low |
| `MISSING_INDEX` | `spec/README.md` と `spec/index.md` の両方が無い | Low |

評価対象 5 分類は `data`、`feature`、`interface`、`setup`、`test`。`faq` と `plan` は存在しても
よいが、常設充実度の missing/empty 判定には使わない。

## grade

- Critical finding があれば `D`。
- High finding があれば `C`。
- finding が 1 件以上なら `B`。
- finding が無ければ `A`。

現行の検査 kind は Critical を生成しないが、report schema は将来の検査追加に備えて
Critical count を保持する。

## CLI

```text
anatomia spec-review --repo <path> [--json]
```

`--json` は `SpecReviewReport`、無指定時は grade、severity 内訳、分類、finding の修正案と
criterion を表示する。finding は severity、path、kind の安定順で並ぶ。検査結果だけでは
exit code を失敗にせず、読み取りや引数処理そのものが失敗した場合だけ例外になる。

## 制約

- 本機能は配置と最低限の分類充実度だけを検査し、実装との意味的な対応や文書内容の正しさは
  検査しない。コードとの対応は[コード構造レビュー](./code-review.md)を使う。
- missing category は、その分類がプロジェクトに該当しない場合も Low note として出る。
- 既存 spec の移動、生成、削除は行わない。

## 関連

- [コード構造レビュー](./code-review.md)
- [ドメインレビュー](./domain-review.md)
- [テスト設計](../test/test-design.md)

