---
task: viewer-program-domain-tab-20260813
project: Anatomia
kind: 実装
created: 2026-08-13T04:00:00.000Z
memory_links:
  - spec/feature/viewer-scene-domain-tabs.md
  - spec/feature/module-layer.md
---
# ビューア ドメインタブ — プログラムサブタブ (クラス図 + 依存関係)

## 目的
ドメインタブのプログラムサブタブを実装する。layer 別プログラムドメイン一覧・クラス図・
依存グラフと、ビジネス層への相互ナビゲーション。

## 完了条件
- [ ] 一覧: layer ごとにプログラムドメインを一覧 (cohesion / modularity Q / misfit 数つき)。`unclassified` diagnostic も表示。
- [ ] クラス図: 所属機能単位の `enclosingType` を集約 (既存 `/api/graph` の `views.class` を流用)。継承 / 実装 / 参照 edge。
- [ ] 依存関係: プログラムドメイン間の依存グラフ (越境結合を重み、layer 違反エッジ = 下位層→上位層依存を強調)。ドメイン内はモジュール→モジュール粒度へドリルダウン。
- [ ] ビジネスへのつながり: 重み付き対応表 + ジャンプ + 根拠展開。「紐づけなし」CodeSymbol の件数表示。
- [ ] `GET /api/projects/:id/program-domain-view` (prepared cache)。
- [ ] 既存 `/api/projects/:id/domain-view` は互換 read として残し、新 UI からは使わない。
- [ ] typecheck / vitest green。

## スコープ (編集可ディレクトリ)
- `src/adapters/web/`, `src/web-cache/`, `src/domains/`, `src/graph/`, `public/`
