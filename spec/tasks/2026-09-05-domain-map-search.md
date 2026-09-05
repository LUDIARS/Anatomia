---
task: domain-map-search
project: Anatomia
kind: 実装
created: 2026-09-05
memory_links: []
---
# 横断ドメインマップ検索と plan の品質修正

## 目的

作業開始時の指示文は「トランポリンカウンターで〇〇」「切り絵のデモを実装する」のように
**プロダクト名やコンテンツ名**で書かれ、リポジトリ名もドメイン名も含まない。
`where` / `plan` は 1 プロジェクトの内側しか探せず、プロジェクト選択は人間任せだったため、
指示文をそのまま渡しても着地点にたどり着けなかった。

そこで **プロダクト → コンテンツ → コアドメイン → 主要パス → 関連サービス** を
全プロジェクト横断で引ける決定的な索引 (`src/map/`) を作り、`plan` の前段に置く。
索引は committed な宣言 (`spec/domains/*.domain.json`、`content-sources.json`、
`.anatomia/layers.json`、spec の H1) だけから作るので LLM が要らず、検索はミリ秒級で終わる。

あわせて、第 1 PR の実測で見つかった `plan` の 2 つの品質欠陥を直す。
「データ定義」に `size` / `empty` / `count` / `begin` / `end` などのアクセサが混ざり、
「手本」が被参照数だけで `snippet_cache.h:size` になる — どちらも著者にとって
情報量がゼロで、ドメイン先行コーディングの入口としては使えなかった。

設計の正本は `Ars/spec/plan/2026-09-05-anatomia-domain-plan-tool.md` §12 (A-12 / A-13 / A-14)。

## 完了条件

- `src/map/` を SRP 分割で新設する (`types` / `aliases` / `content-sources` /
  `project-codes` / `links` / `sources` / `inverted-index` / `search` / `bundle` /
  `format` / `index`)。1 レコード = `{ project, kind, name, aliases[], coreDomain,
  programDomains[], paths[], spec, links[] }`。
- 索引の出所を決定的にする: ドメイン宣言 / `content-sources.json` (無いリポは
  `spec/feature/*.md` の H1 で代替) / `.anatomia/layers.json` / 他プロジェクト名と
  HTTP 経路のリンク / 表記ゆれ正規化。Cc `GET /v1/project-codes` の取得失敗時は
  ロースターを空にし、その理由を `notes[]` に残す。
- プロジェクト解析時に web-cache artifact `domain-map` として保存し、全登録
  プロジェクト分を 1 つの倒立索引に束ねる。`sourceKey` による変更検知で
  **変わったプロジェクトだけ**を再構築する。
- `GET /api/domain-map/search?q=&limit=` と `GET /api/domain-map/:project`、
  CLI `map search "<指示文>"` / `map show <project>` を足す。
- `plan` に `--hints-from-map` (既定 ON、`--no-map` で無効) を足し、検索命中の
  project を `--project` 候補に、coreDomain を domainHints に流す。0 件なら
  `questions[]` に「索引に無い。新規コンテンツか表記ゆれ」を載せる。
- 各リポへ投入する `content-sources.json` の内容を `spec/feature/domain-map.md` と
  PR 本文に書く (対象リポは読み取り専用なので実ファイルは置かない)。同等物を
  `src/map/__tests__/fixtures/` にテスト fixture として置く。
- 受け入れをテストで固定する: 「トランポリンカウンターで〇〇」→ Ludellus
  `uni-jump-trampoline` (`renderer/mr/games/uni-jump`, `renderer/lib/jump`) が 1 位、
  「切り絵のデモ」→ Figmentum `kirie-transform` と Pictor の該当ドメインが上位。
- plan の「データ定義」を型定義と公開 API 関数に絞る (アクセサ・operator 除外)。
- plan の「手本」を 非アクセサ → task トークン一致数 → 同 layer → 被参照数 の順で選ぶ。
- 上記 2 つの品質修正を回帰テストで固定する。
- `src/map/` を Anatomia 自身の `spec/domains/supply-verify.domain.json` の
  membership に同 PR で追加する。
- `spec/feature/domain-map.md` を追加し、`spec/feature/domain-plan.md` を更新する。

## 検証結果 (Anatomia verify)

`git diff` を `anatomia verify --repo <worktree> --diff` にかけて **PASS**。

```
PASS
  [PASS] rule_conformance
  [PASS] duplication
  [PASS] spec_linkage
  [PASS] coupling_delta
  [PASS] convention_drift
```

`spec_linkage` は初回 FAIL (orphan code) だったため、`src/map/*` と
`src/supply/plan/hints.ts` に `// @implements SPEC-domain-map` を付け、
`spec/feature/domain-map.md` の H1 に `{#SPEC-domain-map}` を与えて解消した。

テストは `npx vitest run` で 1529 passed / 1 failed。唯一の失敗は
`src/spec-review/review.test.ts` で、worktree の git submodule `lib/aiformat` が
未初期化なことによる既知の worktree 事情 (本変更とは無関係)。

## 実行例 (実データ、登録済み全プロジェクト横断)

```
$ anatomia map search "トランポリンカウンターで連続跳躍を数える" --limit 4
ドメインマップ検索: トランポリンカウンターで連続跳躍を数える
  1. ludellus → uni-jump — トランポリン カウンター [content] → uni-jump-trampoline
     → renderer/lib/jump, renderer/mr/games/uni-jump, scripts/interpres-proxy.mjs ほか2件
     → loopback 5382, /api/v1/frame, /api/v1/preview.jpg  (score 256.447)
  2. ludellus → uni-jump-trampoline [core-domain] → renderer/lib/jump, ... (score 2.302)
```

```
$ anatomia map search "切り絵のデモを実装する" --limit 4
  1. pictor → 影絵デモ — 切り絵バックドロップ [content]  (score 11.314)
  ...
  4. figmentum → kirie-transform [core-domain] → src/kirie, include/figmentum/kirie, ... (score 0.943)
```

`--project` を渡さない plan が、指示文だけから着地プロジェクトとドメインを決める:

```
$ anatomia plan --task "トランポリンカウンターのミッション表示を直す" --no-llm
ドメイン計画: トランポリンカウンターのミッション表示を直す
  1. ludellus/uni-jump-trampoline	[既存] layer=test  uni-jump のトランポリン計数と…
       データ定義: CameraPreview (type, renderer/lib/jump/camera-preview.js), CountDisplay …
       手本: test/uni-jump-pile-world.test.mjs:createWorld (被参照 15)
  備考:
    - ドメインマップ検索の上位: ludellus/uni-jump-trampoline, …
```

## 再利用の採否

- `supply/relevance.ts` の `tokenizeRelevanceText` を**採用**。日本語 2-gram 化を
  既に持っており、map と plan が「task の語」について食い違わないようにするため。
- `supply/plan/conformance.ts` の glob 文法を**踏襲**(同じ規則を content-sources に適用)。
  関数自体は非 export なので `map/content-sources.ts` に同一仕様で持たせた。
- `supply/landing.ts` の `pickPrecedent` は**同点処理としてのみ採用**。plan の手本は
  `where` の着地点選択とは目的が違うため、絞り込み条件を plan 側に足した。
- `web-cache/search.ts` (LLM 検索) は**不採用**。map は LLM を使わない決定的検索で、
  対象も 1 プロジェクトの関数ではなく全プロジェクトのコンテンツであるため。
