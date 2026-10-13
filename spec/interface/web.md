# interface: Web サーバ HTTP API（管理パネル + warm harness）

`anatomia web --port <n>`（既定 4200）→ `src/adapters/web/server.ts`（Hono）。常駐 HTTP。
ProjectManager を背後に持つ（multi-project）か bare AnalysisContext（single-project）で起動。
**single-project モードでは mutation 系ルートは 501** を返す。

ルートグループは `src/adapters/web/routes/`（analysis / projects / cache / cost / harness /
branch / domain-view）。

## 静的 / 解析系 read

| メソッド | パス | 返り |
|---|---|---|
| GET | `/api/graph` | 関数グラフ互換 payload + `defaultView` + `views.function` / `views.class`（`?project=<id>`） |
| GET | `/api/metrics` | `NodeMetrics[]`（`?project=<id>`） |
| GET | `/api/domains` | `{ domains: string[], cards: [] }`（`?project=<id>`） |
| GET | `/` | 管理パネル SPA（index.html） |

## プロジェクト管理（manager モードのみ）

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/projects` | list + selected |
| POST | `/api/projects` | add + analyze（body `{ name, rootPath }`） |
| DELETE | `/api/projects/:id` | remove |
| POST | `/api/projects/:id/analyze` | (再)解析 |

## per-project データ

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/projects/:id/summary` | counts |
| GET | `/api/projects/:id/hotspots` | coupling/complexity 上位 N |
| GET | `/api/projects/:id/spec-links` | コード↔spec リンク |
| GET | `/api/projects/:id/domains` | ドメイン検出結果 |
| GET | `/api/projects/:id/vis-data` | vis-network データ（export.ts と共有） |
| GET | `/api/projects/:id/branch-diff` | ブランチ差分の関数 delta（`?base=<ref>`、→ feature/branch-diff.md） |
| GET | `/api/projects/:id/branches` | base セレクタ用の ref 一覧 `{ current, autoBase, candidates[] }` |
| GET | `/api/projects/:id/domain-view` | ドメイン別フォーカス + spec 由来の日本語説明（→ feature/domain-view.md） |
| POST | `/api/projects/:id/test-suggestions` | Augur の通常提案。`focusedTesting.domains` 指定時は Anatomia 解析に基づく集中的テスト提案（→ feature/focused-testing.md）。Augur は CLI 子プロセスで呼ぶ（→ interface/augur-bridge.md） |
| GET | `/api/projects/:id/access-patterns` | singleton/Service Locator/Facade のヒューリスティック検出 + アクセス元ドメイン（→ feature/access-patterns.md） |
| GET | `/api/projects/:id/screens` | 静的画面構成 ScreenGraph（→ feature/screen-composition.md） |
| GET | `/api/projects/:id/scenes` | `{ derived, manual, merged }` — 呼び出し閉包で導出したシーン層（fingerprint キー付き artifact = シーンキャッシュ）+ 手動シーンのマージ（→ feature/scene-derivation.md） |
| GET | `/api/projects/:id/spec-config` | spec 正本の解決結果 `{ source: configured\|auto\|root\|missing, dirs? }`（→ feature/spec-source-config.md） |
| PUT | `/api/projects/:id/spec-config` | `{ specDirs: string[] }` で設定 / `{ specDirs: null }` でクリア（自動検出に戻す）。mutation なので ANATOMIA_WEB_TOKEN ゲート対象 |

## 人間承認付きドメイン発見

正本は [feature/domain-discovery-workflow.md](../feature/domain-discovery-workflow.md)。
proposal / inspect は read-only、apply は人間確認と解析 snapshot の一致が必須。

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/projects/:id/flow/draft` | 解析済み spec または `discordMessageUrl` 添付→ドメイン候補 + reconcile preview（保存しない） |
| POST | `/api/projects/:id/flow/apply` | Gate A。編集済み候補を `confirmApply` + `snapshotId` で適用し孤立調査へ進む |
| GET | `/api/projects/:id/flow/orphans` | 未所属関数の全 `file:line`、module group、大群候補、閾値未満残余 |
| POST | `/api/projects/:id/flow/orphan-proposals` | 選択した大群を LLM で詳細調査し、domain + feature spec draft を返す（保存しない） |
| POST | `/api/projects/:id/flow/orphan-apply` | Gate B。人間補足済み候補だけを保存し、再解析した残余未所属一覧を返す |
| GET | `/api/projects/:id/flow/drafts` | 現在保存されている editable domain definitions |
| POST | `/api/flow/draft` | `discordMessageUrl`（または `repoPath` / `specPath`）から proposal。Discord/global 時は `dir` 必須 |

`minGroupFunctions` は正の整数（既定 3）。`snapshotId` が現在解析と異なる場合は
`409 stale_*`。Gate A / B で `confirmApply:true` が無ければ `409 human_confirmation_required`。
生成 spec は既存 `spec/feature/domain-<slug>.md` を暗黙に上書きしない。
Gate A の承認 marker が無い、または承認後に ontology が変わった状態で step 3 以降を呼ぶと
`409 gate_a_required|gate_a_stale`。ファイル適用後の registry 同期・再解析だけが失敗した場合は、
適用済み path と再解析要求を含む `202` を返し、適用そのものを失敗扱いに偽装しない。
Discord 添付 mode は `ANATOMIA_DISCORD_BOT_TOKEN` が無ければ `501`。複数の Markdown/text 添付は
`attachmentId` / `attachmentName` で一意選択し、曖昧なら `409`（→ feature/domain-authoring.md）。

## warm harness（per-edit / per-prompt フック）

常駐ゆえ解析済みプロジェクトを warm 保持し sub-second で応答する。フックは server 不在なら
無言で skip する薄い HTTP クライアント。

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/verify` | `{ diff, project? }` → `Verdict`（5 ゲート） |
| GET | `/api/context` | `?project=&task=` → `ContextBundle` |
| POST | `/api/plan` | `{ project, projects?, task, llm?, okf? }` → `{ plan, markdown, okf? }`（→ feature/domain-plan.md）。`llm` の既定は true（LLM 分解、10 秒級）。`false` で決定的分解のみ。manager モード専用（単一 context では 501） |

## キャッシュ / コスト / トレース

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/cache-stats` | `{ enabled, logPath?, report? }`（A-3 cache hit 率） |
| POST | `/api/cost-feed` | 他サービスからの cost 要約を取り込み（→ data/cost-feed.md） |
| GET | `/api/cost-feed` | 集計 cost レポート（パネル用） |
| GET | `/api/trace/timeline` | `TimelineData`（動的 viz、→ feature/dynamic-trace-and-phase.md） |
| GET | `/api/trace/active` | `ActiveOverlay` |
| GET | `/api/trace/where` | `WhereLabel` |

## ドメインのコードを見る（Tela / Web）

ドメイン一覧の各カードの「コードを見る (Tela / Web)」から、そのドメインの実装関数を選んで
Tela のソース専用ウインドウで開くか、ブラウザ上で表示する。カードの中で完結するので、
元のドメインへはそのまま戻れる。候補は解析結果の implementor から作り、全件を選択肢にする
（先頭ファイルを推測で開かない）。

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/projects/:id/source-view/candidates?domain=` | `{ ok, domain, candidates: [{ anchor, name, enclosingType, file, line }] }`（file は repo 相対、位置順） |
| GET | `/api/projects/:id/source-view/status` | `{ configured, local, message? }` — 起動できない理由を先に出す |
| GET | `/api/projects/:id/source-view/content?file=&line=` | Web 表示。`{ ok, file, line, lineCount, stale, start, lines[], enclosing }` |
| POST | `/api/projects/:id/source-view/launch` | `{ file, line, acceptStale? }` → `{ ok: true, file, line, stale }` または `{ ok: false, reason, message, file, line }` |

### Tela source viewer launch

- **どの端末のファイルをどこで開くか**: Anatomia web サーバが動く PC 上で、その PC のファイルを
  Tela（`tela_source --font <ttf> --source <file> --line <N>`）で開く。ソケットが loopback で、
  かつ転送ヘッダ（`Forwarded` / `X-Forwarded-*` / `X-Real-IP` / `CF-Connecting-IP`）が無い直接の
  要求だけを起動対象にする。別端末・中継（Excubitor viewer、トンネル）からの要求は 403
  `remote-client` / `forwarded` で断り、ファイルと行を返す。`Origin` がサーバ自身でない要求は
  `cross-origin` で断る。
- **何を起動するか**: ビューアとフォントはサーバの設定 `ANATOMIA_TELA_SOURCE_BIN` /
  `ANATOMIA_TELA_FONT`（任意で `ANATOMIA_TELA_FONT_SIZE` 8..48）だけから取る。未設定・ファイルが
  無い場合は推測せず 503 `not-configured` / `viewer-missing` / `font-missing`。要求からコマンドや
  実行パスを組み立てない。起動は引数配列・`shell: false`・detached。
- **どのマシンで出すか**: 「Tela で開く」は Tela がインストール済みのマシン（status の
  `configured: true` = ビューアとフォントが実在）でだけ表示する。未インストールのマシンでは
  ボタンも設定を促す案内も出さず、Web 表示だけを出す（neco 2026-10-13「Telaはインストール済みの
  マシンのみ有効」）。インストール済みでも別端末・中継から開いている場合は、ボタンを残して
  開けない理由を添える。判定は `viewerChoices`（source-view-logic.js）。
- **パスの検証**: 要求は repo 相対パスと行のみ。登録プロジェクトの root 配下に解決し、symlink を
  辿った後も root 配下であることを確かめる。絶対パス・`..` 越え・NUL は拒否。8 MiB 超は
  `too-large`。行は Tela と同じ規則（CRLF / LF / 単独 CR、空ファイルは 1 行）で数え、範囲外は
  `line-out-of-range`。
- **解析後の変更**: ファイルの SHA-256 が解析時の `contentHash` と異なる場合は 409 `stale`。
  利用者は「現在の内容で開く」（`acceptStale: true`）か再解析を選ぶ。存在しないファイルは
  `missing-file`（再解析を案内）、範囲外の行は「先頭から開く」を選べる。
- 実装: `src/adapters/web/source-view-{target,launch,request,candidates}.ts`、
  `src/adapters/web/routes/source-view.ts`、画面ロジック `src/adapters/web/public/source-view-logic.js`、
  画面（ドメインカードの候補選択・起動結果・Web 表示）`src/adapters/web/public/source-view-panel.js`（index.html はカードにボタンを置くだけ）。
  Tela の描画・閲覧状態は Tela が持ち、Anatomia は複製しない。

### Web source view

neco 2026-10-13「Web で指定のコードをビジュアライズする実装も欲しい」。Tela はサーバ PC に
開くため、どこから開いていても読めるブラウザ表示を併設する。

- 同じパス検証（上記）を通したファイルの、指定行の前 40 行・後 80 行を返す。「前へ / 次へ」で
  窓を移動する。行番号は元ファイルのまま。
- 指定行を含む解析済み関数（最内）の範囲を強調し、その関数の呼び出し元・呼び出し先
  （calls 辺、各 30 件まで、超えたら `truncated`）を表示する。名前を押すとその関数へ移る。
- 本文は文字列として返し、画面は `textContent` で描く（HTML として解釈しない）。UTF-8 として
  読めないファイルは `not-utf8` で断る。読み取り専用で、転送経由の閲覧も許可する（起動を
  伴わないため。サーバ自体の公開範囲は loopback 既定 / `ANATOMIA_WEB_TOKEN` に従う）。

## 関連

- 機能: [feature/graph-export-and-panel.md](../feature/graph-export-and-panel.md)
- データ: [data/project-cache.md](../data/project-cache.md)、[data/cost-feed.md](../data/cost-feed.md)
