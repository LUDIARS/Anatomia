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

### planned knowledge settings（T51）

| フィールド | 型 | 意味 |
|---|---|---|
| `knowledgeWriteRoot?` | `string` | domain/log/generated/annotation を置く repository 内の単一 write root |

`specDirs[]` は複数の read root、`knowledgeWriteRoot` は単一 write root。未設定時の決定規則と
fail-fast 条件は [spec source config](../feature/spec-source-config.md) を正本とする。

## cache/<projectId>/snapshot.json（増分解析キャッシュ）

`CacheSnapshot`（`src/project/cache.ts`）。解析結果（`AnalysisContext`）は live な
tree-sitter AST を含み直列化できないため、**結果はプロセス内メモリにキャッシュ**し、
ディスクには変更検知に足る小さな fingerprint だけを残す。

| フィールド | 型 | 意味 |
|---|---|---|
| `version` | `3` | スキーマ版。analyzer semantics の変更時は fingerprint が同一でも旧版を無効化する |
| `projectId` | `string` | プロジェクト id |
| `fingerprint` | `string`（sha256 32hex） | **解析前** fingerprint。各ソース/spec の `{path, contentHash}` をソートして hash（`{size, mtimeMs}` は content hash memo の検証キーであって fingerprint 入力ではない） |
| `merkleHash` | `string` | **解析後** の DAG Merkle hash（RepoNode、→ [merkle-dag.md](./merkle-dag.md)） |
| `fileCount` / `functionCount` | `number` | 件数 |
| `summary?` | `SummaryCounts` | first-view 用の集計（files/functions/nodes/edges/domains/links）。`domains` は semantic project domain のみで policy result を含まない。旧スナップショットには無い |
| `analyzedAt` | `string`（ISO） | 解析時刻 |

### 増分の仕組み（2 段）

1. 再解析要求時にまず `computeFingerprint(rootPath)` を計算（パース無し・content hash ベース）。
   メモリ内 fingerprint と一致すれば解析を**完全スキップ**して既存 ctx を返す（`hits++`）。
2. 解析後に DAG から `merkleHash` を導出し、上記スナップショットを永続化。
   コールド起動時は現在 fingerprint と persisted fingerprint を比較し、解析の要否を判断する。

`AnalysisCache.hits / misses` は観測用カウンタ。CLI の `project analyze` / MCP
`anatomia.projects.analyze` はこの増分により `(cache hit)` を報告する。

> fingerprint（`src/project/fingerprint.ts`）が見る拡張子は
> `.cpp / .h / .cs / .js / .jsx / .mjs / .cjs / .ts / .tsx / .mts / .cts / .java / .go / .md`。
> これは **`analyze()` の収集拡張子（→ [feature/static-analysis.md](../feature/static-analysis.md)）の
> superset でなければならない**。解析されるのに stamp されない拡張子があると、その編集で
> fingerprint が動かず古いキャッシュが返る。
> 走査は directory-pruning walk（`src/fs/walk.ts`）で `node_modules / dist / .git / .anatomia` を降りない。
> あわせて **git が無視するパスも対象外**（`src/fs/git-ignore.ts` が `git ls-files --others --ignored
> --exclude-standard --directory` に委ねる）。untracked でも無視されていないファイルは対象に残る
> ため、書いた直後の新規ファイルは fingerprint にも解析にも入る。
> git が答えられない場合（git 不在 / work tree 外）はルート `.gitignore` の素のディレクトリ名だけを
> 見る旧方式にフォールバックする。非 git ディレクトリも解析対象に保つための経路。
> なお fingerprint と `analyze()` は同じ `collectProjectFiles` を通るので、除外集合は常に一致する
> （片方だけが見るファイル、が生じない）。

## planned knowledge / generated artifact 境界

T53-T55 後も `cache/<projectId>` は破棄可能な derived storage であり、Git 管理の
`<knowledgeWriteRoot>/data/domain-map/*.knowledge.jsonl` を置かない。knowledge log は project source、
Kuzu と web-cache は Anatomia home の rebuildable projection である。

planned cache key は用途別に分ける。

| revision | 入力 | 用途 |
|---|---|---|
| `sourceFingerprint` | authored spec/code/asset/config の bytes | 静的解析。generated/log transaction を含めない |
| `sceneDefinitionFingerprint` | scene に関係する code/asset/detector config | scene definition sync |
| `approvedRelationRevision` | domain/spec/code-owner 等の approved semantic operations | assignment/card/scene-domain 導出 |
| `expectedKnowledgeHead` | knowledge log 全 transaction の head | 排他制御。解析入力ではない |
| `projectionFingerprint` | source/relation revision + knowledge head + projection schema | Kuzu/manifest/Web cache stale 判定 |
| `outputFingerprint` | generated artifact bytes | write-if-changed / ownership manifest |

resolved `<knowledgeWriteRoot>/data/generated/anatomia/**` と scene code-sync transaction 自身は
`sourceFingerprint` / `sceneDefinitionFingerprint` へ戻さない。scene sync が knowledge head を変えても
source 解析を再度無効化せず、consumer projection だけが stale になる。これにより scene OKF の sync
自体が次の解析 miss と再生成を起こす feedback loop を防ぐ。

現行 `computeFingerprint` は既に content ベース（各ファイルの SHA-256 + `configDirs` の
`.md/.mjs/.js/.json`）なので、planned `sourceFingerprint` との差は「何を stamp するか」だけになる。
T52/T54 で generated subtree を stamp 対象から外すとき、`sourceFingerprintVersion` を明示して
旧 snapshot を安全に miss させる。

関連: [domain knowledge log](./domain-knowledge-log.md) /
[OKF generation](../feature/okf-generation.md)。
