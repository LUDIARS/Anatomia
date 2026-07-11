# feature: シンボル検索と caller/callee 探索

## 目的

解析済み関数 index と calls graph を使い、関数の定義位置、Anchor ID、fan-in/fan-out、直接の
caller/callee を決定的に調べる。全文検索の文字列一致ではなく、Anatomia が抽出した function
node と calls edge を問い合わせる。

実装は [`src/graph/symbol-lookup.ts`](../../src/graph/symbol-lookup.ts)、CLI 配線は
[`src/adapters/cli.ts`](../../src/adapters/cli.ts)。

## 検索

`find` は関数名 index に対して次の mode を持つ。

- `exact`（既定）: 大文字小文字を含めて完全一致。0 件なら substring 検索へ fallback する。
- `prefix`: case-insensitive 前方一致。
- `substring`: case-insensitive 部分一致。

返却上限は既定 20 件。結果は source path、開始位置、関数名の順で安定 sort し、各
`SymbolHit` に `name`、`signature`、`filePath`、`startLine`、`endLine`、`anchor`、`fanIn`、
`fanOut` を含める。

## caller / callee

`callers` と `callees` は関数名または 16 桁 hexadecimal Anchor ID を受ける。

- 関数名の場合は exact 一致する全定義を起点にする。
- Anchor ID の場合は graph に実在する 1 node を起点にする。存在しなければ空結果。
- `callers` は直接の `calls` predecessor、`callees` は直接の `calls` neighbor を返す。
- 複数起点から同じ neighbor が得られた場合は Anchor ID で重複排除する。
- 再帰的 transitive closure は行わない。

## CLI

```text
anatomia find <name> [--mode exact|prefix|substring] [--limit <n>]
anatomia callers <name-or-anchor> [--limit <n>]
anatomia callees <name-or-anchor> [--limit <n>]
```

共通して `--repo <path>` または `--project <id>`、`--json` を利用できる。`--json` は
`{ hits: SymbolHit[] }`、無指定時は `name file:line fanIn= fanOut= anchor` を 1 hit 1 行で表示し、
0 件は `(no hits)` とする。`find` / `callers` / `callees` で対象引数が無い場合は即時エラー。

## 制約

- calls edge を静的に解決できない dynamic dispatch、reflection、外部 callback は結果に
  含まれないことがある。
- 同名関数は 1 件に決め打ちせず、全 exact 定義を起点にする。
- source location の座標は解析器が保持する `SourceRange` をそのまま返す。

## 関連

- [静的解析](./static-analysis.md)
- [グラフ export と panel](./graph-export-and-panel.md)
- [context supply](./context-supply.md)
