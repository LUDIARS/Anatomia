# feature: 静的解析（解剖 → Merkle DAG → コードグラフ）

## 目的

リポジトリのソースを「機構」へ解剖し、決定的にハッシュ化した Merkle DAG とその上の
コードグラフ（KG）を組む。これが Anatomia の全機能（ドメイン検出 / spec linkage / verify /
context 供給）の土台になる。

## 振る舞い（入力 → 処理 → 出力）

入口は `analyze(repoPath, options?)`（`src/core.ts`）。`AnalysisContext` を返す。
パイプライン（DESIGN の G1→G5）：

```
.cpp/.h/.cs/.ts/.tsx を再帰収集（node_modules / dist / .git / *.d.ts は除外）
  → parse（tree-sitter, WASM はグローバルキャッシュ）
  → extractFunctions（関数抽出）
  → normalize（body 正規化）
  → assignAnchorId（Anchor ID 付与 = body 正規化 + signature のハッシュ）
  → buildFileNode / FileNode Merkle（→ data/merkle-dag.md）
  → extractEdgeInfo → buildGraph → InMemoryCodeGraph（KG）
  → 【G3】detectDomains（→ feature/domain-detection.md）
  → 【G4】spec linking（→ feature/spec-linkage.md）
```

`AnalysisContext` の主フィールド：`repoPath / graph / files / functions /
specClauses? / links? / domains? / skipped?`。

## 言語判定

拡張子マップ（`langFor`）：`.cs → c_sharp`、`.tsx → tsx`、`.ts → typescript`、
それ以外（`.cpp / .h`）→ `cpp`。

## 決定性 / 耐障害性

- **Anchor ID** は意味が同じなら同一。これがキャッシュ命中（増分解析・LLM 蒸留）の土台。
- パース/抽出/正規化に失敗したファイルは **crash せず skip** し、理由付きで
  `AnalysisContext.skipped[]` に記録する（解析全体は止まらない）。
- ドメイン検出・spec linking の失敗も握りつぶし、その層が欠けた ctx を返す。

## 出力経路

- CLI `context` / `where` / `export-graph` / `verify`（→ interface/cli.md）
- MCP 7 ツール（→ interface/mcp.md）
- web サーバの解析系 API（→ interface/web.md）

## 関連

- データ: [data/merkle-dag.md](../data/merkle-dag.md)、[data/project-cache.md](../data/project-cache.md)
- 影響半径クエリ: `getImpactRadius(ctx, anchor)` = グラフの BFS 到達集合（MCP `anatomia.impact`）。
