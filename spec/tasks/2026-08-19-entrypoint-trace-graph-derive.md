---
task: entrypoint-trace-graph-derive-20260819
project: Anatomia
kind: 実装
created: 2026-08-19T03:00:00.000Z
memory_links:
  - spec/feature/entrypoint-trace-graph.md
  - spec/feature/scene-derivation.md
  - spec/feature/dynamic-edge-recovery.md
---
# 入口トラバーサ + product graph + artifact / projection

## 目的
[entrypoint-trace-graph.md](../feature/entrypoint-trace-graph.md) のトラバーサと出力を実装する。
入口 manifest (前タスク) を入力に、入口ごとの到達木と製品全体の到達グラフを fingerprint 付き artifact にする。

## 完了条件
- [ ] traversal を `src/scenes/derive.ts` と `src/knowledge/scene/derive.ts` の両方の `reachClosure` と共通化 (`src/graph/` か `src/traverse/` に抽出し両 scene 側もそれを呼ぶ)。BFS、`distance` / `via` (親候補複数は anchor 昇順で決定)、`maxDepth` 到達は diagnostic。
- [ ] node に `UnresolvedCall` 由来の `frontier[]` (`calleeName` / `receiverType` / `reason`) を付与。集計 `frontierCount`。
- [ ] `reachedFrom` の和、`unrooted[]` (どの入口からも届かない CodeSymbol)。入口ゼロは `no-entry-detected` + 全 unrooted。
- [ ] 着色: owner (ビジネスドメイン) / belongs-to (プログラムドメイン) を**参照のみ**で付与、入口ごとに `activatesDomains` 集計。ドメイン側の書込ゼロ。
- [ ] `EntryPointGraph` を `<generated>/entrypoint-graph.json` へ (fingerprint キー、canonical JSON)。knowledge log の code-sync transaction + Kuzu / web-cache projection は scene / program-domain と同型で。
- [ ] `project analyze` の一環で導出 (再解析なしで cache から読める)。
- [ ] typecheck / vitest green。決定性テスト。既存 scene テスト不変。

## スコープ (編集可ディレクトリ)
- `src/entrypoints/`, `src/graph/`, `src/scenes/`, `src/knowledge/`, `src/web-cache/`, `src/core.ts`
