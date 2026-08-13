---
task: program-domain-derivation-20260813
project: Anatomia
kind: 実装
created: 2026-08-13T04:00:00.000Z
memory_links:
  - spec/feature/domain-dual-layer.md
  - spec/feature/module-layer.md
---
# プログラムドメイン導出 (layer 分類器 + 合成 + 永続化)

## 目的
[domain-dual-layer.md](../feature/domain-dual-layer.md) のプログラムドメイン層を実装する。
機能(module)単位を基礎に layer 分類 → プログラムドメイン合成 → knowledge sync/projection まで。

## 完了条件
- [ ] layer 分類器: `.anatomia/layers.json` (path glob → layer 宣言) → フレームワーク規約 → 依存方向ヒューリスティックの優先順で機能単位ごとに layer を決める。決定不能は `unclassified` diagnostic。
- [ ] プログラムドメイン合成: 同一 layer 内でプログラムツリー隣接 + 越境結合の強い機能単位群を畳む。閾値・畳み方は設定で決定的に固定 (LLM 無し・時刻無し)。
- [ ] 全域性: 全 CodeSymbol が belongs-to edge を持つ。持てない symbol は `unclassified` として surface (黙って default に入れない)。
- [ ] knowledge log の code-sync transaction (scene と同型) + deterministic projection (`program-domains.json` / Kuzu / Web cache)。fingerprint キー付き artifact。
- [ ] builtin オントロジー検出結果はドメインとして表示しない (evidence としてのみ残す)。
- [ ] typecheck / vitest green。決定性テスト (同一入力 → byte 同一出力) を含む。

## スコープ (編集可ディレクトリ)
- `src/domains/`, `src/modules/`, `src/knowledge/`, `src/frameworks/`, `src/web-cache/`
