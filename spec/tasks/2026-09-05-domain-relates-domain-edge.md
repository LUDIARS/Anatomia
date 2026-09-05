---
task: domain-relates-domain-edge
project: Anatomia
kind: 実装
created: 2026-09-05
memory_links:
  - anatomia-knowledge-edge-endpoints
---
# コアドメイン間の関係辺 domain-relates-domain を knowledge に足す (A-8)

## 目的
設計書 `Ars/spec/plan/2026-09-05-anatomia-domain-plan-tool.md` §7.2 A-8。
knowledge の辺は `subdomain-of` (階層) のみで、ドメイン間の関係辺
(依存 / 協調 / 共有カーネル = DDD のコンテキストマップ) が無い。
「コアドメインはリストとグラフで記述される」(§7 思想) のグラフ側が欠けている。

## 完了条件
- knowledge に edge kind `domain-relates-domain` を追加し、辺の `relation` に
  `depends-on` / `collaborates` / `shared-kernel` のいずれかを持たせる。
  (`KnowledgeEdge.kind` は edge kind の discriminant なので、関係種別との二重用途にしない。)
- 辺の候補は program-domain 依存の集約から LLM が下書きし、**人間承認 (Gate A と同型)**
  を通ったものだけを knowledge へ書く。下書きをそのまま権威データにしない。
- ビジネスドメインビュー (`BusinessDomainViewPayload`) を、リストに加えて
  関係辺を持つグラフとして返せるようにする。
- knowledge log は端点の無い辺を拒否するため、派生層は既存 entity id に filter して
  辺を張る (memory: `anatomia-knowledge-edge-endpoints`)。
- 承認前の候補が view に出ないこと、承認済みだけが出ることをテストで固定する。
- `npm run typecheck` / `npm test` green、`npm run build`。Revisor local PR 提出。

## スコープ (編集可ディレクトリ)
- `src/knowledge/` (edge 型・log validation・domain approval を含む)
- `src/web-cache/` (business-domain-view)
- `spec/data/domain-knowledge-log.md` / `spec/feature/domain-dual-layer.md`
