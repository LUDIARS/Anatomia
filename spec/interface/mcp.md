# interface: MCP サーバ（7 ツール）

`bin/anatomia-mcp.mjs` → `src/adapters/mcp.ts`。stdio transport の MCP サーバ。
AI ホスト（Claude Code / Famulus / Concordia）から supply / verify / project を直接呼ぶ。

- **transport**: stdio。**stdout は MCP 専用**（汚さない）。診断はすべて stderr。
- **登録例**: `.mcp.json` の `mcpServers.anatomia`（`command: node`, `args: ["bin/anatomia-mcp.mjs"]`）。
- 起動時に配線したプロバイダを stderr にログ（`[anatomia/mcp] providers: …`）。
- プロバイダ（embedder + LLM）は環境変数から解決（→ [setup/environment.md](../setup/environment.md)）。

## ツール一覧

サーバ名 `anatomia`（version `0.1.0`）。コア 4 + プロジェクト管理 3 = **7 ツール**。
コア 4 は任意の `project`（id）引数を取り、ProjectManager 配線時はそのプロジェクト
（既定は selected）に作用する。

| ツール | 入力（zod） | 返り |
|---|---|---|
| `anatomia.context` | `task: string`, `project?: string` | `ContextBundle`（JSON text） |
| `anatomia.verify` | `diff: string`, `project?: string` | `Verdict`（5 ゲート、→ feature/verify-gates.md） |
| `anatomia.where` | `task: string`, `project?: string` | `{ landings: Landing[] }` |
| `anatomia.impact` | `anchor: string`, `project?: string` | `{ anchors: string[] }`（BFS 到達 anchor） |
| `anatomia.projects.list` | （なし） | `{ projects: Project[], selected: string\|null }` |
| `anatomia.projects.add` | `name: string`, `rootPath: string` | `{ project: Project }` |
| `anatomia.projects.analyze` | `project?: string` | `{ project, files, functions, cacheHit }` |

応答はいずれも `content: [{ type: "text", text: JSON.stringify(result) }]`。

## プロジェクト管理ツールの可用性

`projects.*` の 3 ツールは **ProjectManager 配線時のみ登録される**（bare
AnalysisContext の単一プロジェクトモードでは登録されない）。本番 `main()` は registry が
空なら cwd を `default` プロジェクトとして登録し、project ツールも使えるようにする。

## キャッシュ計測（任意）

`ANATOMIA_CACHE_LOG` 設定時、card cache の get と LLM 呼び出し usage を同一 transcript に
記録（→ [data/llm-cache.md](../data/llm-cache.md)）。集計は CLI `cache-stats`。

## 関連

- 機能: [feature/context-supply.md](../feature/context-supply.md)、[feature/verify-gates.md](../feature/verify-gates.md)
- 他経路: [interface/cli.md](./cli.md)、[interface/web.md](./web.md)
