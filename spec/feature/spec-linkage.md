# feature: 仕様リンク（spec linkage, G4）

## 目的

コードと仕様（`spec/*.md` + `DESIGN.md`）を結びつける。これにより、生成された変更が
仕様の意図に紐づいているか（孤児でないか）を verify の spec_linkage ゲートで判定できる。

## 振る舞い

`analyze()` の Phase 5（`src/core.ts`）：

```
collectSpecFiles(.md) → parseSpecFiles → SpecClause[]
  → findExplicitLinks(clauses, sourcePaths)   …明示アノテーション
  → findStructuralLinks(clauses, sourcePaths) …命名/配置ヒューリスティック
  → links = [...explicit, ...structural]
```

OKF parser（T52、2026-08-04 実装）は frontmatter、list/table/definition/code fence、modality、
explicit clause ID、source range を保持する（`src/knowledge/okf-parser.ts`）。resolved
`<knowledgeWriteRoot>/data/generated/anatomia/**` 配下または `x-anatomia.generated: true` の
文書は route が `generated` になり clause を出さないので、scene OKF が次回の authored spec
input へ自己還流しない。domain/annotation subtree も同様に authored-spec 以外へ route する。

typed authoring root（domain/annotation）に kind 不一致の文書があると、その文書は fail-closed
で落とすが `parseSpecFiles` は残りのファイルを解析する。1 文書の不備でリポジトリ全体の
リンクが 0 件に落ちるのを避けるため、per-file で隔離する。

### SpecClause
Markdown を semantic unit（heading / paragraph / list-item / table-row / definition /
code-reference）へ分解する（`src/spec/parse.ts` → `src/knowledge/okf-parser.ts`）。見出し単位では
なくなったので、1 文書から出る clause 数は旧 parser より多い。`slugify` は表示/URL 用の
ASCII slug として残る。

stable binding は explicit clause ID（`[id: x]` / `{#x}`）を優先し、無い場合だけ document ID +
heading ancestry + unit kind + 兄弟 index の provisional structural address を使う。本文 hash
（`revisionHash`）は改訂 evidence であって identity ではない。表示名、domain path も
長期 identity にしない。

### Explicit リンク（`src/spec/explicit.ts`）
コード中の `@implements SPEC-xxx` / `@spec <text>` アノテーション、および spec 文中の
コードファイル参照を拾う。evidence = `"explicit"`（高信頼）。

### Structural リンク（`src/spec/structural.ts`）
節の見出し/本文キーワードとコードファイルパスのキーワードの **Jaccard 単語重なり** で
中信頼リンクを出す（`MIN_SCORE = 0.1`、confidence 0.4〜0.8）。

### Semantic リンク（`src/spec/semantic.ts`）
embedding cosine による節↔ファイルのリンカ。embedder は注入式（モジュール自身は API を
叩かない）。`analyze()` の既定経路では explicit + structural を結線。

## verify での使われ方

spec_linkage ゲート（`src/supply/gates/spec_linkage.ts`）は、変更関数の anchor が
いずれかの Link の `from` に一致するか（fallback でソースファイルパス一致）で「リンク済み」を
判定し、孤児を警告する。既定は warn、strict 時は block。

## 関連

- データ: [data/merkle-dag.md](../data/merkle-dag.md)（SpecClause / Link）
- ゲート: [feature/verify-gates.md](./verify-gates.md)
- OKF: [feature/okf-generation.md](./okf-generation.md)
