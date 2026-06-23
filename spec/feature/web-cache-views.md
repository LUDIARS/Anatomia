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

`graph` (vis-data) / `domain-view` / `hotspots` / `spec-links` / `domains` /
`scene-modules` / `search-corpus`。

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
POST /api/projects/:id/prepare-web-cache   全ビュー生成 + 永続 → manifest
GET  /api/projects/:id/web/manifest        prepared? + stale?
GET  /api/projects/:id/web/:view           1 ビュー (未生成は 409 not-prepared)
POST /api/projects/:id/web/search          { query } → LLM 検索結果
```

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
- 全タブは `/web/:view` を読み、未生成は描画せずエラー + 生成ボタン。
- 新タブ: **Search** / **Scene·Domain·Module** / **Adjust**。
- 純粋ロジックは `public/web-views-logic.js` (ブラウザ + 単体テスト兼用、
  `domain-view-logic.js` と同じ方式)。
