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

### SpecClause
Markdown を見出し単位で節に分解（`src/spec/parse.ts`）。`slugify` で URL-safe な
ASCII slug を持つ。

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
