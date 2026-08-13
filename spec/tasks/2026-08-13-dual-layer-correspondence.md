---
task: dual-layer-correspondence-20260813
project: Anatomia
kind: 実装
created: 2026-08-13T04:00:00.000Z
memory_links:
  - spec/feature/domain-dual-layer.md
---
# ビジネス⇄プログラムドメイン対応の query 導出

## 目的
CodeSymbol の owner edge (ビジネス、Gate B 承認済み) と belongs-to edge (プログラム、自動) を
突合し、`BusinessDomain ⇄ ProgramDomain` の重み付き many-to-many 対応を query 時に導出する。
保存はしない (transitive edge を保存しない原則)。

## 完了条件
- [ ] `ProgramDomain → BusinessDomain[]` / `BusinessDomain → ProgramDomain[]` の重み付き集計 (経由 CodeSymbol 件数)。
- [ ] 導出根拠の提示: 対応表の各行から経由した CodeSymbol / SpecClause の `file:line` 一覧を引ける。
- [ ] owner edge の無い CodeSymbol は「紐づけなし」として空のまま件数提示 (既存ビジネスドメインへ押し込まない)。
- [ ] SpecClause 側: spec-code link 経由の `SpecClause → ProgramDomain` (任意 refines) 導出。
- [ ] prepared cache (web-cache prepare) に同梱し、query 時再解析を発生させない。
- [ ] typecheck / vitest green。

## スコープ (編集可ディレクトリ)
- `src/domains/`, `src/knowledge/`, `src/web-cache/`
