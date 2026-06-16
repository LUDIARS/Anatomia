# Anatomia — Claude Code ルール

## プロジェクト概要

Anatomia はコード解析 × 決定的キャッシュで AI のクリーンなコード生成を支える
建築規約オラクル（LUDIARS、略称 **`An`**）。

supply → verify ループが重心。DAG（正規化 Merkle-AST、関数粒度）→ KG（Kuzu 派生ビュー）→
ドメイン検出 → コード↔仕様リンク → 5 ゲート検証という G1–G5 パイプライン。

詳細設計は [`DESIGN.md`](./DESIGN.md)、解析手順は [`spec/usage/analysis-procedure.md`](./spec/usage/analysis-procedure.md)。

## ブランチ + PR 運用

すべての変更は feat ブランチ → PR → squash merge。main 直 push 禁止。
（初回構築は直 main だったが、以降はこのルールを守る。）

## コード規約

共通: `coding-conventions` スキル (= `AIFormat/RULE_CODE.md`) を参照。以下は Anatomia 固有の上書き / 追加。

### SRP とファイル分割

- `src/dag/`、`src/graph/`、`src/spec/`、`src/domains/`、`src/supply/`、`src/dynamic/`、`src/adapters/` の
  レイヤ境界を越えない。
- 新機能は既存レイヤのどこかに属する。新しいディレクトリを勝手に切らない。

### ビルドとテスト

```sh
npm run build     # tsc → dist/（CLI/MCP は dist/ をロード）
npm run typecheck # tsc --noEmit
npm test          # vitest run
```

コード変更後は必ず `npm run typecheck` で型エラー確認 → PR 前に `npm test` 全通。

### CLI / MCP

`bin/anatomia.mjs` / `bin/anatomia-mcp.mjs` は `dist/` を読む。
**コード変更後は `npm run build` が必須**（`dist/` の古いファイルをそのまま実行しない）。

### テストの置き場

- 各モジュール隣の `__tests__/` ディレクトリに配置。
- ファイル名は `*.test.ts`。
- 外部 API / ファイルシステムへの実依存はテストに持ち込まない（hermetic が原則）。

## 参照

- `anatomia-analyze` スキル — MCP 不要で CLI 経由解析
- `coding-conventions` スキル — LUDIARS 共通コード規約
- [[project_anatomia]] — メモリ上のプロジェクトコンテキスト
