---
task: entrypoint-graph-surfaces-20260819
project: Anatomia
kind: 実装
created: 2026-08-19T03:00:00.000Z
memory_links:
  - spec/feature/entrypoint-trace-graph.md
  - spec/feature/viewer-scene-domain-tabs.md
  - spec/feature/context-supply.md
  - spec/feature/graph-export-and-panel.md
---
# 入口グラフの表面: CLI / HTTP / export-graph / ビューア [入口] タブ / ContextBundle

## 目的
[entrypoint-trace-graph.md](../feature/entrypoint-trace-graph.md) の artifact を人と AI が読める面に出す。

## 完了条件
- [ ] CLI `anatomia entrypoints --project <id> [--json] [--entry <anchor|name>] [--unrooted] [--frontier]`。exit 0 固定 (gate ではない)。
- [ ] `GET /api/projects/:id/entrypoint-graph` / `GET /api/projects/:id/entrypoint-graph/:entryId` (prepared cache から。開いた瞬間の再解析なし)。
- [ ] `export-graph --mode entrypoints`: 入口を根にした forest、unrooted は灰色クラスタ、frontier は破線末端。既存描画を共有。
- [ ] ビューア: トップタブに [入口] を追加。入口一覧 (class / 到達数 / frontier 数) → 到達木 + 着色ドメイン、シーン / ドメインタブへ stable ID deep link。
- [ ] ContextBundle (`where` / `context` / `/api/context`) に `nearestEntries[]` (着地点に最短で届く入口 ≤3)。既存フィールドは維持し、結果形状の変更に合わせて bundle cache version を上げる。
- [ ] typecheck / vitest green。CLI と HTTP のテスト各 1 件以上。

## スコープ (編集可ディレクトリ)
- `src/adapters/`, `src/supply/`, `src/web-cache/`, `src/entrypoints/`, `public/`
