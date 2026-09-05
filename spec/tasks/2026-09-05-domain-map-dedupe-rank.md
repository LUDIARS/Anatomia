---
task: domain-map-dedupe-rank
project: Anatomia
kind: 実装
created: 2026-09-05
memory_links: []
---
# 横断ドメインマップの死んだ登録の除外・重複集約と日本語順位の是正

## 目的
設計書 `Ars/spec/plan/2026-09-05-anatomia-domain-plan-tool.md` §12 の横断ドメインマップ
検索 (`src/map/`) に、2026-09-05 実測で 2 つの不具合が残っていた。

1. **索引に死んだ登録が混ざる**。共有レジストリ `Ars/.anatomia/projects.json` は
   使い捨て worktree を登録したまま誰も消さないため、`GET /api/domain-map/search` の
   `projects[]` に消えたチェックアウトが並び、`pictor` と `pictor-5bfd9645e639` が
   同一リポの二重登録として同じコンテンツ「影絵デモ — 切り絵バックドロップ」を
   同スコアで 2 件返していた (実測 74 プロジェクト)。
2. **日本語の指示文で主題のドメインが沈む**。「切り絵のデモを実装する」で、
   description に「切り絵」を持つ Figmentum `kirie-transform` が 5 位 (0.865) で、
   「切り絵」を一切含まない Cernere `demo` (2.292) と Figmentum
   `fg-web-audio-tools` (1.247) の下にいた。原因はフィールド重み (description=1) と
   日本語 2-gram の扱い (3 文字の主題語が 2 個の安いトークンに崩れる / カナ畳みで
   同じ出現が二重計上される) にある。

レジストリを手で消すだけでは再発するため、**コードで恒久的に効く形**に直す。

## 完了条件
- 索引を組む前に、root が存在しない登録と、`.anatomia` しか残っていない登録
  (解析対象が消えた worktree の抜け殻) を除外する。
- `git rev-parse --show-toplevel --git-common-dir` で求めた **本体 root +
  チェックアウト内パス**をキーに、同一リポの重複登録を 1 件へ集約する。本体が
  未登録のときだけ worktree 側を残し、リポジトリのサブディレクトリ登録は畳まない。
- 代表 id は 本体チェックアウト → 素の id → 短い id → 辞書順 の優先で決め、
  `<name>-<12桁hex>` の自動生成 id を劣後させる (`pictor-5bfd9645e639` → `pictor`)。
- 除外・集約の件数と理由を `notes[]` (API 応答 / CLI 出力) と `console.warn` +
  Vestigium に出す。黙って消さない。
- ランキング: `core-domain` の description を索引の第一級フィールドに戻し
  (重み 1 → 3)、連続する日本語 2-gram を両方持つレコードへフレーズ加点を与え、
  カナ畳みの二重計上をやめる。
- 受け入れをテストで固定する (fixture、実データ依存なし)。
  - 「切り絵のデモを実装する」で `figmentum/kirie-transform` が上位 3 位以内。
  - Pictor の content「影絵デモ — 切り絵バックドロップ」は引き続き上位に残る。
  - `cernere/demo` と `figmentum/fg-web-audio-tools` は `kirie-transform` より下。
  - 「トランポリンカウンターで連続跳躍を数える」→ `ludellus/uni-jump-trampoline`
    が 1 位のまま。「量子暗号の鍵配送を実装する」は 0 件のまま。
  - 同一リポの二重登録が 1 件に畳まれ、検索結果に同じコンテンツが 2 度出ない。
- `spec/feature/domain-map.md` を更新する。`src/map/` 配下のテスト green、
  `npm run typecheck` / `npm run build` green、PR 差分に `anatomia verify`
  (block ゲート全 PASS)。Revisor local PR 提出。

## 検証方針

共有レジストリや他セッションの状態はリポジトリへ記録せず、合成 fixture で再現する。
受け入れテストは、死んだ root の除外、重複登録の集約、検索順位、既存検索の回帰を
決定的に検証する。

## スコープ (編集可ディレクトリ)
- `src/map/`
- `src/branch/git.ts` (リポジトリ root 解決の git プリミティブ)
- `spec/feature/domain-map.md`
