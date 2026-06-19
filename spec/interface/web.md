# interface: Web サーバ HTTP API（管理パネル + warm harness）

`anatomia web --port <n>`（既定 4200）→ `src/adapters/web/server.ts`（Hono）。常駐 HTTP。
ProjectManager を背後に持つ（multi-project）か bare AnalysisContext（single-project）で起動。
**single-project モードでは mutation 系ルートは 501** を返す。

ルートグループは `src/adapters/web/routes/`（analysis / projects / cache / cost / harness /
branch / domain-view）。

## 静的 / 解析系 read

| メソッド | パス | 返り |
|---|---|---|
| GET | `/api/graph` | `{ nodes: CodeNode[], edges: Edge[] }`（`?project=<id>`） |
| GET | `/api/metrics` | `NodeMetrics[]`（`?project=<id>`） |
| GET | `/api/domains` | `{ domains: string[], cards: [] }`（`?project=<id>`） |
| GET | `/` | 管理パネル SPA（index.html） |

## プロジェクト管理（manager モードのみ）

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/projects` | list + selected |
| POST | `/api/projects` | add + analyze（body `{ name, rootPath }`） |
| DELETE | `/api/projects/:id` | remove |
| POST | `/api/projects/:id/analyze` | (再)解析 |

## per-project データ

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/projects/:id/summary` | counts |
| GET | `/api/projects/:id/hotspots` | coupling/complexity 上位 N |
| GET | `/api/projects/:id/spec-links` | コード↔spec リンク |
| GET | `/api/projects/:id/domains` | ドメイン検出結果 |
| GET | `/api/projects/:id/vis-data` | vis-network データ（export.ts と共有） |
| GET | `/api/projects/:id/branch-diff` | ブランチ差分の関数 delta（`?base=<ref>`、→ feature/branch-diff.md） |
| GET | `/api/projects/:id/domain-view` | ドメイン別フォーカス + spec 由来の日本語説明（→ feature/domain-view.md） |

## warm harness（per-edit / per-prompt フック）

常駐ゆえ解析済みプロジェクトを warm 保持し sub-second で応答する。フックは server 不在なら
無言で skip する薄い HTTP クライアント。

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/verify` | `{ diff, project? }` → `Verdict`（5 ゲート） |
| GET | `/api/context` | `?project=&task=` → `ContextBundle` |

## キャッシュ / コスト / トレース

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/cache-stats` | `{ enabled, logPath?, report? }`（A-3 cache hit 率） |
| POST | `/api/cost-feed` | 他サービスからの cost 要約を取り込み（→ data/cost-feed.md） |
| GET | `/api/cost-feed` | 集計 cost レポート（パネル用） |
| GET | `/api/trace/timeline` | `TimelineData`（動的 viz、→ feature/dynamic-trace-and-phase.md） |
| GET | `/api/trace/active` | `ActiveOverlay` |
| GET | `/api/trace/where` | `WhereLabel` |

## 関連

- 機能: [feature/graph-export-and-panel.md](../feature/graph-export-and-panel.md)
- データ: [data/project-cache.md](../data/project-cache.md)、[data/cost-feed.md](../data/cost-feed.md)
