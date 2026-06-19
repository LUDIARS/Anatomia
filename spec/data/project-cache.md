# data: プロジェクトレジストリ + 増分解析キャッシュ

複数プロジェクトを登録して解析するときの永続データ。すべて Anatomia home 下に置く。

## home の解決

`resolveHome()`（`src/project/store.ts`）— 先勝ち：

1. 明示 `homeDir` 引数（`web --home <dir>`）
2. 環境変数 `ANATOMIA_HOME`
3. `<cwd>/.anatomia`

home 下のレイアウト：

```
<home>/
├── projects.json                       # レジストリ
└── cache/<projectId>/snapshot.json     # 増分解析スナップショット
```

## projects.json（レジストリ）

`RegistrySnapshot`（`src/project/types.ts`）を pretty JSON で永続化（`saveRegistry`）。
ファイルが無い/壊れているときは空レジストリとして起動（first-run friendly）。

```jsonc
{
  "version": 1,
  "selected": "<projectId> | null",   // 既定/選択中プロジェクト
  "projects": [ Project, ... ]
}
```

### Project

| フィールド | 型 | 意味 |
|---|---|---|
| `id` | `string` | 決定的 id（`name` の slug、無名時は `rootPath` のハッシュ） |
| `name` | `string` | 表示名 |
| `rootPath` | `string` | `analyze()` が走査する絶対パス |
| `languages?` | `Lang[]` | 言語 allow-list（情報用。実際は auto-detect） |
| `ontologyDir?` | `string` | このプロジェクト固有のドメインオントロジー plugin dir |
| `addedAt` | `string`（ISO） | 登録時刻 |

## cache/<projectId>/snapshot.json（増分解析キャッシュ）

`CacheSnapshot`（`src/project/cache.ts`）。解析結果（`AnalysisContext`）は live な
tree-sitter AST を含み直列化できないため、**結果はプロセス内メモリにキャッシュ**し、
ディスクには変更検知に足る小さな fingerprint だけを残す。

| フィールド | 型 | 意味 |
|---|---|---|
| `version` | `1` | スキーマ版 |
| `projectId` | `string` | プロジェクト id |
| `fingerprint` | `string`（sha256 32hex） | **解析前** fingerprint。各ソース/spec の `{path, size, mtimeMs}` をソートして hash。中身は読まない |
| `merkleHash` | `string` | **解析後** の DAG Merkle hash（RepoNode、→ [merkle-dag.md](./merkle-dag.md)） |
| `fileCount` / `functionCount` | `number` | 件数 |
| `summary?` | `SummaryCounts` | first-view 用の集計（files/functions/nodes/edges/domains/links）。旧スナップショットには無い |
| `analyzedAt` | `string`（ISO） | 解析時刻 |

### 増分の仕組み（2 段）

1. 再解析要求時にまず `computeFingerprint(rootPath)` を計算（パース無し・mtime ベース）。
   メモリ内 fingerprint と一致すれば解析を**完全スキップ**して既存 ctx を返す（`hits++`）。
2. 解析後に DAG から `merkleHash` を導出し、上記スナップショットを永続化。
   コールド起動時は現在 fingerprint と persisted fingerprint を比較し、解析の要否を判断する。

`AnalysisCache.hits / misses` は観測用カウンタ。CLI の `project analyze` / MCP
`anatomia.projects.analyze` はこの増分により `(cache hit)` を報告する。

> fingerprint が見る拡張子は `.cpp / .h / .cs / .ts / .tsx / .md`。
> 走査は directory-pruning walk（`src/fs/walk.ts`）で `node_modules / dist / .git / .anatomia` を降りない。
