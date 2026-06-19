# data: Merkle-AST DAG（正規化 AST の content-addressed 表現）

Anatomia の解析土台。コードを関数粒度に解剖し、**意味が同じなら同一ハッシュ**になる
content-addressed な Merkle DAG として保持する。DB ではなくプロセス内のデータ構造
（実装は `src/dag/`、グラフ射影は `src/graph/`）。永続化されるのはこの DAG から派生した
キャッシュスナップショット（→ [project-cache.md](./project-cache.md)）と LLM 蒸留カード
（→ [llm-cache.md](./llm-cache.md)）。

## ノード階層

```
RepoNode ── files[] ──▶ FileNode ── functions[] ──▶ FunctionNode (Anchor ID)
```

### FunctionNode（関数）
関数 1 つ。`assignAnchorId(fn, normalize(fn.bodyAst))` で **Anchor ID** を付与する
（`src/dag/hash.ts` / `src/dag/normalize.ts`）。Anchor ID = body 正規化 + signature(型) の
ハッシュ。意味が同じ関数は同一 ID になり、キャッシュ命中の土台になる。

| フィールド | 型 | 意味 |
|---|---|---|
| `id` | `AnchorId \| null`（sha256 由来） | 正規化 body + signature のハッシュ。hash 前は `null` |
| `name` | `string` | 関数名 |
| `bodyAst` | AST | tree-sitter から抽出した本体 AST |
| `sourceRange` | `{ filePath, start, end }` | ソース位置 |

### FileNode（ファイル）
`buildFileNode(path, functions)`（`src/dag/merkle.ts`）。`hash` = 子 FunctionNode の
`id` 群を **ソートして改行連結 → SHA-256**。ソートにより順序非依存：ファイル内で関数を
並べ替えても hash は不変、1 関数を変えるとその関数 + ファイル hash だけが変わる。

| フィールド | 型 | 意味 |
|---|---|---|
| `path` | `string` | ソースファイルパス |
| `hash` | `string`（SHA-256 hex） | 子関数 id のソート連結ハッシュ |
| `functions` | `FunctionNode[]` | 含む関数 |

### RepoNode（リポジトリ）
`buildRepoNode(files)`（`src/dag/merkle.ts`）。`hash` = 子 FileNode の `hash` 群を同じく
ソート連結した SHA-256。リポ全体の content fingerprint であり、プロジェクトキャッシュの
`merkleHash` の源（→ [project-cache.md](./project-cache.md)）。

## 派生ビュー

- **KG（Knowledge Graph）**: DAG 上のグラフ射影。`CodeGraphQuery` インタフェース
  （`src/graph/query.ts`）に対し In-Memory 実装（`src/graph/in-memory.ts`）と
  Kuzu 実装（`src/graph/kuzu.ts`）。Kuzu は再生成可能な materialized view で、
  ノード表 `CodeUnit(id, name, kind, file, sline, eline)` / `SpecClause(...)` 等を持つ。
- **SpecClause / Link**: spec markdown を解析した節と、コード↔spec のリンク
  （→ [feature/spec-linkage.md](../feature/spec-linkage.md)）。

## 解析対象

`analyze(repoPath)`（`src/core.ts`）が収集する拡張子は `.cpp / .h / .cs / .ts / .tsx`。
`node_modules / dist / .git`、`*.d.ts` は除外。spec markdown は `.md`。
パース/抽出に失敗したファイルは crash せず `AnalysisContext.skipped[]` に理由付きで記録。
