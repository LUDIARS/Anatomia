# Web 表示キャッシュ + ビュー刷新 (web-cache-views)

Anatomia の Web パネルを「都度計算」から「事前計算キャッシュを描画する」方式へ刷新する。

## 原則

- パネルは **事前計算された web キャッシュのみ** を描画する。キャッシュが無いビューは
  描画してはならない — エラー表示 + 「キャッシュ生成」ボタンで生成を促す。
- Web で見るデータは最新でなくてよい。各ビューは生成日付 (`preparedAt`) を持ち、
  source が変わっていれば stale として示すが、**自動再生成はしない**。
- 検索・retune は LLM が要る。**LUDIARS は API を使わず claude CLI (`claude -p`) で動かす**
  (鍵が無ければ backend は claude-cli に推論される)。明示 stub backend のときだけ
  fail-fast (501) — 無言のスタブ/部分文字列フォールバックはしない
  ([[feedback_no_silent_fallback]])。

## キャッシュ機構

保存先 `<cacheRoot>/<projectId>/web/`:

- `manifest.json` — `WebCacheManifest` (preparedAt / fingerprint / views / counts)
- `<view>.json` — `WebViewEnvelope<T>` (view 毎に preparedAt + fingerprint + data)

fingerprint-keyed の派生 artifact (`project/cache.ts`) とは別物。web キャッシュは
**現在の fingerprint に関係なく読み戻す** (最新でなくてよい)。fingerprint は記録し、
manifest 取得時に現在値と比較して `stale` を返す。

`src/web-cache/`:

| ファイル | 役割 |
|---|---|
| `types.ts` | `WebViewName` / envelope / manifest / scene-modules / search 型 |
| `store.ts` | web ディレクトリの read/write (fingerprint 非依存の読み戻し) |
| `build.ts` | analyze 1 回 → 全ビュー構築 (module 評価は1回だけ計算し共有) |
| `module-access.ts` | module→module アクセス集計 (どこを触るか) |
| `scene-modules.ts` | シーン→ドメイン→モジュール (関数数/アクセス/違反を事前計算) |
| `search-corpus.ts` | 検索コーパス (関数/ドメイン/モジュール/spec) 構築 |
| `search.ts` | LLM 検索 (Haiku 解析 → prefilter → Haiku rerank) |

既存のインライン構築は再利用関数へ切り出し済 (現状ロジック不変):
`supply/hotspots.ts` / `domains/spec-links.ts` / `domains/domain-view-payload.ts`。

## ビュー一覧 (バンドル)

`graph` (vis-data) / `domain-view` / `access-patterns` / `hotspots` /
`spec-links` / `domains` / `scene-modules` / `search-corpus`。

### access-patterns (アクセスパターン)

`patterns/detect.ts` の singleton / service-locator / facade / network 検出結果。
**以前は Domain View を開く度にライブルート `/access-patterns` が走り**、warm サーバ
再起動直後はコンテキストキャッシュが空 → **リポ全体の再解析 + 全ソース再読込** を
強制していた (キャッシュ非経由のクリティカルパス)。prepare 時に 1 回検出して
ここに永続し、パネルは `/web/access-patterns` をディスクから読むだけにした。
ライブルート `GET /api/projects/:id/access-patterns` は API 互換のため残す
(パネルは使わない)。

### domain-view (ドメインビュー)

`views` (ドメイン + JP 説明 + implementor) / `modulesByDomain` (機能単位の凝集度) /
`modularity` `granularity` `misfits` に加え、**`graphByDomain`** を含む。これは各
ドメインの**機能単位グラフを事前集約**したもの (units + 色 + 件数 + 重み付き
module→module ペア; `domains/view-graph.ts`)。**以前はパネルが全関数粒度の `graph`
(vis-data) を丸ごと DL し、ドメイン選択の度にクライアントで関数→モジュール集約を
やり直していた**。事前集約により、パネルは `graphByDomain[domain]` を引いて軽量な
fold (hub/弱エッジ除去; `public/domain-view-logic.js: foldUnitGraph`) のみを行う。
集約の単位 (`group`) は vis-data と同一なので、nodes/edges は build 側から渡す
(domains 層は adapters 層の vis-data builder に依存しない)。

### scene-modules (シーンステート-ドメイン-モジュール調整ビューの表示面)

シーン→ドメイン→モジュールのみ表示。ドメイン中心のリスト描画は従来どおり。
モジュール毎に事前計算: `functionCount` (内包関数数) / `accesses` (アクセス先
module + kind) / `violationCount` (このドメインの違反が触る数)。モジュールは
既存 Domain View と同じ構造モジュール (dir 粒度) を使い凝集度を保持。

### search

LLM 由来検索と同様、任意文章を受け取り Haiku が解析 → コーパス候補抽出 →
Haiku で rerank。LLM は claude CLI (`claude -p`) 経由 (API 不使用)。
コーパスは事前計算、クエリは都度。明示 stub backend では 501 で拒否。

## HTTP ルート

```
POST /api/projects/:id/prepare-web-cache   生成をキュー投入 → 202 { jobId, state }
GET  /api/prepare-jobs                      キュー全体のスナップショット (進捗可視化)
GET  /api/projects/:id/web/manifest        prepared? + stale?
GET  /api/projects/:id/web/:view           1 ビュー (未生成は 409 not-prepared)
POST /api/projects/:id/web/search          { query } → LLM 検索結果
```

### prepare はキュー化 (非同期)

全ビュー生成は analyze + build を伴い、大規模リポ (KuzuSurvivors 等) では数分かかる。
旧実装は POST がそれを同期 await したため、ブラウザの fetch がタイムアウトしていた
(サーバは処理継続するが UI には失敗に見える)。

いまは **サーバ内の直列キュー** (`src/web-cache/prepare-queue.ts`) に投入して即 202 を返す。
- ワーカーは**1件ずつ直列**に処理 (重い解析を同時に走らせると tree-sitter WASM ヒープが
  枯渇するため。[[feedback_anatomia_treesitter_wasm_heap_leak]])。
- 同一プロジェクトが queued/running 中の再投入は **dedup** (既存 job を返す)。完了後の
  再投入は新規 job。
- job は `{ id, projectId, state(queued|running|done|failed), phase, enqueuedAt,
  startedAt, finishedAt, error, result }`。phase は analyzing → building views → writing。
- キューはインメモリ (warm サーバは 180 分アイドルで自動停止するため永続不要)。完了履歴は
  上限付きで保持し、パネルが done/failed を表示できるようにする。
- ランナー (analyze + buildWebCacheBundle + writeWebCache) は注入で渡し、キュー本体は
  ProjectManager / HTTP に依存しない (SRP)。

## 調整サブシステム (E)

curated な taxonomy (`spec/data/<project>.taxonomy.json`, DomainPlan→ModulePlan)
が編集の正本。編集→保存で `registerTaxonomy` が ontology DomainDefs + taxonomy +
spec doc を再生成 = **仕様の調整も自動**。粒度調整は retune の自動フロー
(`domains/retune` pipeline) をそのまま起動。シーンは手動定義
(`spec/data/<project>.scenes.json`) を trace 由来とマージ。

```
GET  /api/projects/:id/adjust/model        { taxonomy, scenes }
POST /api/projects/:id/adjust/domain       add | delete | rename
POST /api/projects/:id/adjust/module       add | delete | rename | move | addPath
POST /api/projects/:id/adjust/scene        add | delete
POST /api/projects/:id/adjust/retune       粒度自動フロー (retune) 起動
```

編集/retune 後は解析キャッシュを invalidate し project.ontologyDir を更新。
web キャッシュは stale になる (UI が再生成を促す)。

## パネル (index.html)

- プロジェクト毎 + ダッシュボードに「キャッシュ生成」ボタン (preparedAt/stale 表示)。
  押下は**キュー投入**で、ボタンは投入後すぐ「キューで生成中…」になり完了でタブを再描画。
- **キュー dock** (左下固定): `/api/prepare-jobs` を定期ポーリング (実行中は 1.2s、idle は
  8s、空なら非表示) し、各 job の project / state / phase / 経過 / エラーを表示。`QueueDock`
  が `waitFor(jobId)` を公開し、生成ボタンが完了を待って後処理する。
- 全タブは `/web/:view` を読み、未生成は描画せずエラー + 生成ボタン。
- 新タブ: **Search** / **Scene·Domain·Module** / **Adjust**。
- 純粋ロジックは `public/web-views-logic.js` (ブラウザ + 単体テスト兼用、
  `domain-view-logic.js` と同じ方式)。
