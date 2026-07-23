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
| GET | `/api/projects/:id/branches` | base セレクタ用の ref 一覧 `{ current, autoBase, candidates[] }` |
| GET | `/api/projects/:id/domain-view` | ドメイン別フォーカス + spec 由来の日本語説明（→ feature/domain-view.md） |
| GET | `/api/projects/:id/access-patterns` | singleton/Service Locator/Facade のヒューリスティック検出 + アクセス元ドメイン（→ feature/access-patterns.md） |

## 人間承認付きドメイン発見

正本は [feature/domain-discovery-workflow.md](../feature/domain-discovery-workflow.md)。
proposal / inspect は read-only、apply は人間確認と解析 snapshot の一致が必須。

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/projects/:id/flow/draft` | spec→LLM ドメイン候補 + reconcile preview（保存しない） |
| POST | `/api/projects/:id/flow/apply` | Gate A。編集済み候補を `confirmApply` + `snapshotId` で適用し孤立調査へ進む |
| GET | `/api/projects/:id/flow/orphans` | 未所属関数の全 `file:line`、module group、大群候補、閾値未満残余 |
| POST | `/api/projects/:id/flow/orphan-proposals` | 選択した大群を LLM で詳細調査し、domain + feature spec draft を返す（保存しない） |
| POST | `/api/projects/:id/flow/orphan-apply` | Gate B。人間補足済み候補だけを保存し、再解析した残余未所属一覧を返す |
| GET | `/api/projects/:id/flow/drafts` | 現在保存されている editable domain definitions |

`minGroupFunctions` は正の整数（既定 3）。`snapshotId` が現在解析と異なる場合は
`409 stale_*`。Gate A / B で `confirmApply:true` が無ければ `409 human_confirmation_required`。
生成 spec は既存 `spec/feature/domain-<slug>.md` を暗黙に上書きしない。
Gate A の承認 marker が無い、または承認後に ontology が変わった状態で step 3 以降を呼ぶと
`409 gate_a_required|gate_a_stale`。ファイル適用後の registry 同期・再解析だけが失敗した場合は、
適用済み path と再解析要求を含む `202` を返し、適用そのものを失敗扱いに偽装しない。

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
