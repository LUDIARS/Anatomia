---
task: entrypoint-detectors-20260819
project: Anatomia
kind: 実装
created: 2026-08-19T03:00:00.000Z
memory_links:
  - spec/feature/entrypoint-trace-graph.md
  - spec/feature/screen-composition.md
---
# エントリポイント検出器 + 設定 + canonical manifest

## 目的
[entrypoint-trace-graph.md](../feature/entrypoint-trace-graph.md) の入口検出層を実装する。
検出器 → `EntryPointSeed[]` → canonical `EntryPointManifest`（stable ID = symbol anchor）。

## 完了条件
- [x] `src/entrypoints/` に detectors: `explicit-config` / `explicit-annotation` (`@anatomia-entry`) / `process-main` / `http-route` / `cli-command` / `event-handler` / `scheduled` / `framework-lifecycle` (既存 `frameworks/unity/lifecycle.ts` を再利用) / `screen` (既存 `screens/detect.ts` を再利用)。
- [x] `.anatomia/entrypoints.json` ローダ (`includeTests` / `include` / `exclude` / `traversal`)。無ければ既定で動く。invalid は `config-invalid` diagnostic (黙って無視しない)。
- [x] テストファイル既定除外 (`*.test.*` / `__tests__/` / `tests/`)、`includeTests: true` で規約検出にも含められる。
- [x] 同一 symbol に複数検出器 → 1 entry に畳み `classes[]` / `detector[]` を保持。ソート済み・決定的。
- [x] Anatomia 自身 (`src/adapters/cli.ts` の subcommand dispatch、`src/adapters/web/routes/*` の `app.get/post`) を fixture にした vitest。Unity fixture (MonoBehaviour lifecycle) と Next file-route fixture、`includeTests` の既定/有効時を各 1 件ずつ。
- [x] typecheck / build green (vitest はセッション方針により未実行)。決定性テスト (同一入力 → byte 同一)。

## スコープ (編集可ディレクトリ)
- `src/entrypoints/`, `src/screens/`, `src/frameworks/`, `src/types.ts` (型追加のみ)
