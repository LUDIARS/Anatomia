# Anatomia 解析手順

Anatomia を実際に動かしてコードベースを解析し、AI のクリーンコード生成に使うまでの手順。
設計の正本は `DESIGN.md`、タスクは `TASKS.md`、MCP 接続は `docs/mcp-setup.md`、
MCP を使わない Skill 接続は Ars 配下のスキル `anatomia-analyze` を参照。

---

## 0. 前提：ビルド

`bin/anatomia.mjs` / `bin/anatomia-mcp.mjs` は `dist/` を読む（`.ts` ソースではない）。
コード変更後は必ずビルドする。

```sh
npm install
npm run build      # tsc → dist/
```

---

## 1. 静的解析（核）

`analyze(repoPath)` が G1→G5 を一気通貫で走らせる。パイプライン：

```
.cpp/.h/.cs/.ts/.tsx を再帰収集 (node_modules / dist / *.d.ts は除外)
  → parse(tree-sitter) → 関数抽出 → 正規化 → ハッシュ (Anchor ID 付与)
  → File Merkle ノード → コードグラフ (InMemoryCodeGraph)
  → ドメイン検出 G3 (builtin ontology + plugin)
  → 仕様リンク G4 (spec/*.md・DESIGN.md を明示 + 構造リンク)
```

- パース/抽出に失敗したファイルは **crash せず skip**（`AnalysisContext.skipped[]` に理由付きで記録）。
- Anchor ID = body 正規化 + signature(型) のハッシュ。意味が同じなら同一 ID（キャッシュ土台）。
- パーサ WASM はグローバルキャッシュ。

### ルート A：単発解析（その場の repo を見る）

```sh
node bin/anatomia.mjs context --repo <path> --task "freeze effect を追加"
node bin/anatomia.mjs export-graph <path> -o graph.html   # 静的グラフを HTML 出力
```

### ルート B：プロジェクト登録（キャッシュ前提・複数リポ）

登録すると Anatomia home に Merkle キャッシュが効き、変更が無ければ再解析がヒットで即返る。

```sh
node bin/anatomia.mjs project add adventure <path-to-AdventureCube>
node bin/anatomia.mjs project list
node bin/anatomia.mjs project analyze adventure   # → "N files, M functions (cache hit)"
```

以後 `--project adventure` を各サブコマンドに付けると、登録 root を解析対象にする。

---

## 2. サブコマンド別の用途

| コマンド | 何をする | 出力 / 終了コード |
|---|---|---|
| `context --task <t>` | タスク用の決定的 ContextBundle（着地点 / 手本 / 既存ドメイン / 仕様）を組む | JSON |
| `verify` | diff を 5 ゲートで検証（rule_conformance / duplication / spec_linkage / coupling_delta / convention_drift） | block 失敗で **exit 1** |
| `where --task <t>` | 着地点（domain × layer × siblings）を解決 | JSON |
| `export-graph -o f.html` | 自己完結インタラクティブグラフ | HTML |
| `web --port 4200` | 複数プロジェクト管理パネル（HTTP 常駐） | サーバ |

`verify` / `context` / `where` / `export-graph` は `--project <id>` で登録プロジェクトを対象にできる。
`--project` 無指定なら `--repo`（既定 cwd）を直接解析する（単発互換）。

**verify は stdin から diff を受ける**（クリーンコード生成の検証ループの肝）：

```sh
git diff | node bin/anatomia.mjs verify --project adventure --json
echo $?    # 0=PASS / 1=block ゲート失敗
```

`--json` で生 JSON、無指定なら人間向けサマリ（`PASS/FAIL` + ゲート別 + suggestion）。

---

## 3. 実 LLM / embedder を効かせる（任意）

未設定なら duplication ゲートは hash-embedder + mock カードで動作（hermetic・API 不要）。
実プロバイダを入れると、既存ドメインを LLM 蒸留カード化して「車輪の再発明」を実検出する。

| 変数 | 効果 |
|---|---|
| `ANTHROPIC_API_KEY` | LLM 蒸留を有効化（既定モデル `claude-opus-4-8`） |
| `ANATOMIA_LLM_MODEL` | LLM モデル上書き |
| `ANATOMIA_EMBED_BASE_URL` / `_API_KEY` / `_MODEL` / `_DIM` | OpenAI 互換 embedder（ローカル Ollama 可） |
| `ANATOMIA_CACHE_DIR` | LLM 蒸留キャッシュ（ドメインカード）を永続・共有ストアに置く。content-addressed＋model/prompt バージョンキーなので、呼び出し/セッション/リポを跨いでヒットする。未設定はプロセス内メモリ |

未設定項目は stub + hash に graceful fallback する（テストは hermetic に保たれる）。
キャッシュキーは `versionedKey(内容ハッシュ, モデル id, プロンプトテンプレ版)`：モデルやプロンプトを
変えると別キーになり stale を返さない（`src/cache/`）。

---

## 4. AI に接続する 2 経路

生成前に文脈を supply、生成後に verify する「重心」ループを AI ホストから回す経路は 2 つ。

### 4.1 MCP（常駐サーバ）

`.mcp.json` に `bin/anatomia-mcp.mjs` を登録すると、AI 側から 7 ツールを直接呼べる：
`anatomia.context` / `.verify` / `.where` / `.impact` / `.projects.{list,add,analyze}`。
設定詳細は `docs/mcp-setup.md`。起動時に配線したプロバイダを stderr にログする。

### 4.2 Skill（MCP 不要・CLI ラッパ）

MCP サーバを立てず、Claude Code のスキルから CLI（`node bin/anatomia.mjs …`）を直接叩く経路。
Ars 配下のスキル `anatomia-analyze` が手順とコマンドを保持する。常駐プロセス不要・設定ゼロで、
1 リポでの単発解析や verify ゲートをそのまま使いたいときに向く。

---

## 5. 自己解析（dogfood）・計測

```sh
npm run measure                 # scripts/measure.mjs：ハッシュ命中率 / 束決定性 / verify 精度
node scripts/self-analyze.mjs   # 自分の src/ を解析（→ docs/self-analysis.md の数値）
```

---

## 6. 動的解析（実行トレース → 局面）

動的層（`src/dynamic/`）は現状 **ライブラリ API のみ**（CLI 未配線）。流れ：

```
ゲートに録画フレーム → stitchFrame(zone ↔ card)
  → discoverPhases() で局面語彙 → induceFsm() で遷移
  → labelPhases()(LLM) → buildClassifier().classifyWindow(現フレーム)
  → buildWhere(..., phaseId) で You-are-here に phase 表示
```

入力となる実ゲームのトレース録画経路（§5.2 マーカー注入 → ringbuffer → `RecordedTraceSource`）は
未配線。現状は `RecordedTraceSource` に frame を流すプログラム/テスト利用に限られる（DESIGN §5.5 / G10）。

---

## 最短ループ

```
npm run build → project add → project analyze → git diff | verify
```

これが Anatomia の「解析して使う」中核ループ。
