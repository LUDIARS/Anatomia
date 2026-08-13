---
task: viewer-business-domain-tab-20260813
project: Anatomia
kind: 実装
created: 2026-08-13T04:00:00.000Z
memory_links:
  - spec/feature/viewer-scene-domain-tabs.md
  - spec/feature/domain-organization.md
---
# ビューア ドメインタブ — ビジネスサブタブ (仕様確認 + 整理 UI 統合)

## 目的
ドメインタブのビジネスサブタブを実装する。approved ビジネスドメインの閲覧・仕様確認・
人間調整 (整理 UI 統合) と、プログラム層への相互ナビゲーション。

## 完了条件
- [ ] hierarchy 一覧: spec-only / implemented / missing を含め非表示にしない。
- [ ] 仕様の確認: authored OKF の purpose / boundary を先頭に、owner SpecClause 群 (heading / excerpt / `file:line`) + spec 原文ビューへのリンク。
- [ ] プログラムへのつながり: 重み付き対応表 (dual-layer-correspondence の query 導出を使用)。各行からプログラムサブタブへジャンプ、展開で経由 CodeSymbol の `file:line` 一覧。「紐づけなし」領域は空として明示。
- [ ] 関連 scene (activates 逆引き) の表示とシーンタブへの deep link。
- [ ] 人間による調整: 既存整理 UI (Domain canvas / Assignment review / Approval、`/domain-organization/:id`) をサブタブに統合。調整はすべて proposal + Gate 経由 (即時 CRUD なし)。
- [ ] `GET /api/projects/:id/business-domain-view` (prepared cache)。
- [ ] typecheck / vitest green。

## スコープ (編集可ディレクトリ)
- `src/adapters/web/`, `src/web-cache/`, `src/knowledge/`, `public/`
