# Anatomia — Claude Code ルール

## プロジェクト概要

Anatomia はコード解析 × 決定的キャッシュで AI のクリーンなコード生成を支える
建築規約オラクル（LUDIARS、略称 **`An`**）。

重心は **supply → verify** ループ。content-addressed な正規化 Merkle-AST（関数粒度）→
KG 派生ビュー → ドメイン検出 → コード↔仕様リンク → 5 ゲート検証 のパイプライン。

- 詳細設計: [`DESIGN.md`](./DESIGN.md)
- 解析手順: [`spec/feature/analysis-procedure.md`](./spec/feature/analysis-procedure.md)
- MCP 不要で CLI から回す手順: `anatomia-analyze` スキル

## ブランチ + PR 運用

すべての変更は feat ブランチ → PR → **squash merge**。main 直 push 禁止。
AI 実装は 1 PR に集約する。

## コード規約

共通規約は `coding-conventions` スキル（= `AIFormat/RULE_CODE.md`）を正本とする。
以下は Anatomia 固有の上書き / 追加。

### SRP とレイヤ境界

`src/` は責務ごとのレイヤに分割されている（`dag` / `graph` / `spec` / `domains` /
`supply` / `dynamic` / `integral` / `review` / `patterns` / `modules` / `scenes` /
`project` / `cache` / `cost` / `branch` / `fs` / `providers` / `plugins` /
`adapters` / `web-cache` 等）。

- 新機能は既存レイヤのいずれかに属させる。レイヤ境界を越えた依存を作らない。
- 新しいトップレベルレイヤを足すのは、既存のどこにも属さない新しい責務が
  生まれたときだけ。安易にディレクトリを切らず、まず既存レイヤを検討する。
- ファイルは単一責任で分割する（SRP）。肥大化したら同レイヤ内で分ける。

### ビルドとテスト

```sh
npm run build      # tsc → dist/（CLI/MCP は dist/ をロード）
npm run typecheck  # tsc --noEmit
npm test           # vitest run
```

コード変更後は `npm run typecheck` で型を確認し、PR 前に `npm test` を全通させる。

### CLI / MCP

`bin/anatomia.mjs` / `bin/anatomia-mcp.mjs` は `dist/` を読む。
**コード変更後は `npm run build` が必須**（古い `dist/` をそのまま実行しない）。

### テストの置き場

- 各モジュール隣の `__tests__/` ディレクトリ、ファイル名は `*.test.ts`。
- 外部 API / ファイルシステムへの実依存はテストに持ち込まない（hermetic が原則）。

### spec/ の構成

`spec/` は AIFormat の分類フォルダに揃える（`data` / `feature` / `interface` /
`setup` / `test`）。`usage/` 等の独自フォルダは作らない（CI の構造チェックで落ちる）。

## 参照

- `anatomia-analyze` スキル — MCP 不要で CLI 経由解析（supply→verify）
- `coding-conventions` スキル — LUDIARS 共通コード規約
- [[project_anatomia]] — メモリ上のプロジェクトコンテキスト
