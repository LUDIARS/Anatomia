# ドメイン taxonomy: anatomia

自己調整パイプライン（[domain-retune](./domain-retune.md)）が生成。反復 1 回。
このファイルは生成物。手で編集せず `npm run retune` で再生成する。

## domain-modeling

コードを top-level 目的（ドメイン）と凝集サブ単位（module）へ分類する。検出・オントロジー・仕様シードの authoring・自己調整(re-tune)を含む建築規約の中心。

- **detection-ontology** — detectDomain と evaluatePredicate によるプラグイン式ドメイン検出（src/domains）  `paths: (^|/)src/domains/[^/]+$, (^|/)src/plugins/[^/]+$`
- **domain-retune** — ドメインビューの 7 ステップ自己調整（src/domains/retune）  `paths: (^|/)src/domains/retune/[^/]+$`
- **domain-authoring** — 仕様シードからの人手調整ドメイン synthesize/reconcile（src/domains/authoring）  `paths: (^|/)src/domains/authoring/[^/]+$, (^|/)src/domains/authoring/__tests__/[^/]+$`
- **module-layer** — 関数とドメインの間の凝集単位の評価（src/modules）  `paths: (^|/)src/modules/[^/]+$, (^|/)src/modules/__tests__/[^/]+$`

## spec-linkage

コード機構を仕様節（SpecClause）へ明示的・構造的・意味的にリンクし、生成の意図を仕様に結びつける。

- **spec-parse-link** — parseMdFile と explicit/structural/semantic リンク探索（src/spec）  `paths: (^|/)src/spec/[^/]+$`

## static-anatomy

コードを関数粒度の正規化 Merkle-AST（DAG）へ解剖し、コードグラフ（呼び出し辺）を構築する解析の核。意味同値で同一 Anchor ID を割り当てキャッシュ土台にする。

- **dag-merkle** — parse / normalize / assignAnchorId による正規化 Merkle-AST 構築（src/dag）  `paths: (^|/)src/dag/[^/]+$, (^|/)src/dag/__tests__/[^/]+$`
- **code-graph** — buildGraph・extractEdgeInfo による呼び出し辺グラフと型解決（src/graph）  `paths: (^|/)src/graph/__tests__/[^/]+$, (^|/)src/graph/[^/]+$`
- **pattern-scan** — Source-level pattern scanning over code (scanForPatterns and helpers) that feeds structural anatomy analysis by detecting recurring idioms/constructs.  `paths: (^|/)src/patterns/[^/]+$`

## delivery-surface

解析機能を外部に届ける入口。CLI/MCP ハンドラ・web 管理パネル・グラフ HTML エクスポート・ブランチ差分・複数プロジェクト管理。

- **cli-mcp** — runCli・createHandlers による CLI/MCP 入口（src/adapters）  `paths: (^|/)src/adapters/__tests__/[^/]+$, (^|/)src/adapters/[^/]+$`
- **web-panel** — createApp・exportGraphHtml・ルート群（src/adapters/web）  `paths: (^|/)src/adapters/web/[^/]+$, (^|/)src/adapters/web/routes/[^/]+$, (^|/)src/adapters/web/__tests__/[^/]+$`
- **project-mgmt** — computeFingerprint・cachedArtifact による複数プロジェクト管理（src/project）  `paths: (^|/)src/project/[^/]+$, (^|/)src/project/__tests__/[^/]+$`
- **branch-diff** — computeBranchDiff によるブランチ差分解析（src/branch）  `paths: (^|/)src/branch/[^/]+$, (^|/)src/branch/__tests__/[^/]+$`

## supply-verify

重心となる supply→verify ループ。生成前に着地点・適用ルール・手本・影響半径・重複回避を供給し、生成後に 5 ゲートで検証してレビューを出す。

- **context-bundle** — buildContextBundle・resolveLanding・impact 半径の供給（src/supply, src）  `paths: (^|/)src/supply/__tests__/[^/]+$, (^|/)src/[^/]+$, (^|/)src/__tests__/[^/]+$, (^|/)src/supply/[^/]+$`
- **verify-gates** — coupling/convention/duplication/rule 等の検証ゲート（src/supply/gates）  `paths: (^|/)src/supply/gates/[^/]+$`
- **review** — buildReview / formatReview による検証結果の整形（src/review）  `paths: (^|/)src/review/[^/]+$, (^|/)src/review/__tests__/[^/]+$`

## deterministic-cache

決定的キャッシュ基盤。content-addressed な LLM 蒸留カードを Redis/File/memory に置き、LLM/embedder プロバイダとコスト計測を束ねる。

- **distill-cache** — resolveCacheStore・createFileStore とセッション集計（src/cache）  `paths: (^|/)src/cache/__tests__/[^/]+$, (^|/)src/cache/[^/]+$`
- **llm-providers** — anthropic / claude-cli / hash-embedder の解決（src/providers）  `paths: (^|/)src/providers/[^/]+$, (^|/)src/providers/__tests__/[^/]+$`
- **cost-accounting** — token/コスト feed の集計（src/cost）  `paths: (^|/)src/cost/__tests__/[^/]+$, (^|/)src/cost/[^/]+$`

## dynamic-analysis

実行トレースを録画・stitch し、局面（phase）を学習して scene 層を実トレースで点灯させる動的解析（G7/G10）。

- **phase-learning** — discoverPhases・buildClassifier による局面学習（src/dynamic/phase）  `paths: (^|/)src/dynamic/phase/[^/]+$`
- **trace-record** — トレース録画と sceneModelFromTraceFile（src/dynamic/record）  `paths: (^|/)src/dynamic/[^/]+$, (^|/)src/dynamic/record/[^/]+$, (^|/)src/dynamic/record/__tests__/[^/]+$`
- **trace-viz** — アクティブオーバレイ・タイムライン可視化（src/dynamic/viz）  `paths: (^|/)src/dynamic/viz/[^/]+$`

## integral-search

関数・機能・scene の 3 層スコープを横断する統合検索。Agent 入力フォーマットに沿ってスコープを判定し seed を解決する。

- **scope-search** — integralSearch・judgeScope・resolveSeeds による 3 層検索（src/integral）  `paths: (^|/)src/integral/[^/]+$, (^|/)src/integral/__tests__/[^/]+$`

## platform-foundation

Foundational filesystem access used across analyzers: directory walking and extension-based file collection (collectFilesByExt) plus its unit tests.

- **fs-traversal** — Foundational filesystem access used across analyzers: directory walking and extension-based file collection (collectFilesByExt) plus its unit tests.  `paths: (^|/)src/fs/[^/]+$, (^|/)src/fs/__tests__/[^/]+$`
- **test-fixtures** — Synthetic mini codebase fixtures (tick/run_once/emit/add) used as deterministic inputs for analyzer and dynamic-trace test suites.  `paths: (^|/)src/__tests__/fixtures/mini/[^/]+$`

