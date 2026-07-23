# Anatomia

コードを「機構」へ解剖し、仕様・実行時挙動に結びつけ、**決定的キャッシュ**の上で
**AI のクリーンなコード生成を支える**建築規約オラクル（LUDIARS、略称 `An`）。

「クリーン」= 抽象的な美しさではなく、その codebase の grain（ドメイン・ルール・仕様）に
逆らわないこと。既存ドメインを再発明せず、結合を無闇に上げず、仕様の意図に結びつき、周りと一貫する。

- **DAG** = 正規化 Merkle-AST（関数粒度・acyclic）＝キャッシュ土台。意味が同じなら同一 Anchor ID。
- **KG** = その上の派生ビュー（Kuzu 射影、関係クエリ用）。
- **Domain split / spec match** = ドメイン分割を管理し、仕様クレームとの突合を Anatomia 側で扱う。
- **Scenes** = 画面・実行局面・複数画面にまたがる workflow/module を同じ「シーン」として定義・管理し、
  実行トレースからも自動検出する。
- **supply→verify ループ**（重心）= 生成前に着地点 / 適用ルール / 手本 / 影響半径 / 重複回避を渡し、
  生成後に 5 ゲートで検証する。

詳細設計は [`DESIGN.md`](./DESIGN.md)、タスクは [`TASKS.md`](./TASKS.md)。

---

## セットアップ

### 必要環境
- Node.js 20+（ESM / `"type": "module"`）
- ネイティブ依存（`kuzu`, `web-tree-sitter` の WASM）を含むため、初回は `npm install` でビルドが走る。

### インストール & ビルド

```sh
git clone https://github.com/LUDIARS/Anatomia.git
cd Anatomia
npm install
npm run build      # tsc → dist/  （bin は dist/ をロードするため必須）
```

> CLI / MCP の入口（`bin/anatomia.mjs` / `bin/anatomia-mcp.mjs`）は `.ts` ソースではなく
> `dist/` を読む。**コード変更後は必ず `npm run build`**。

### スクリプト

| コマンド | 内容 |
|---|---|
| `npm run build` | `tsc` で `dist/` を生成 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `vitest run`（全テスト） |
| `npm run measure` | 計測（ハッシュ命中率 / 束決定性 / verify 精度） |

### 実 LLM / embedder（任意）

LLM 蒸留は既定で **`claude -p` サブスク CLI** を使う（API キー不要）。`ANTHROPIC_API_KEY` を
入れると Anthropic SDK 経路に切り替わる。embedder 未設定なら hash-embedder（hermetic）。
**設定不備（例: backend=anthropic でキー無し）は黙ってスタブに落とさず即エラー**にする
（オフラインの placeholder が欲しいテスト時のみ `ANATOMIA_LLM_BACKEND=stub` で明示）。

| 変数 | 効果 |
|---|---|
| `ANATOMIA_LLM_BACKEND` | LLM backend を明示選択：`anthropic` / `claude-cli` / `stub`。未指定は推論（キーあり→anthropic、無し→**claude-cli**）。`stub` は明示時のみ（自動フォールバックしない） |
| `ANTHROPIC_API_KEY` | Anthropic SDK 経路を選択／有効化（既定モデル `claude-opus-4-8`） |
| `ANATOMIA_CLAUDE_BIN` | `claude-cli` backend が使う `claude` 実行ファイルパス（既定は PATH 解決） |
| `ANATOMIA_LLM_MODEL` | LLM モデル上書き（SDK・CLI 共通） |
| `ANATOMIA_EMBED_BASE_URL` / `_API_KEY` / `_MODEL` / `_DIM` | OpenAI 互換 embedder（ローカル Ollama 可） |
| `ANATOMIA_CACHE_REDIS` | `redis://…` を設定すると LLM 蒸留キャッシュを **Redis（org 横断共有）** に置く。どこかのマシンが蒸留したカードを全員が引けるので命中率が上がり、Redis の `maxmemory`+`allkeys-lfu` で eviction も自動。`redis` は optionalDependency（未導入/到達不可なら無言で no-op に degrade）。`ANATOMIA_CACHE_REDIS_TTL`（秒）で保持上限も可。backend 優先度 = **Redis > File > memory** |
| `ANATOMIA_CACHE_DIR` | 設定すると LLM 蒸留キャッシュ（ドメインカード）を**永続・共有**ストア（per-machine file）に置く。content-addressed なので呼び出し/セッション/リポを跨いでヒットする。未設定はプロセス内メモリ（hermetic） |
| `ANATOMIA_CACHE_LOG` | 設定すると LLM キャッシュの **hit/miss と LLM 呼び出しの token 使用量** を JSONL transcript に追記する（MCP サーバ経路）。`anatomia cache-stats` で命中率を集計。未設定は計測 off（ゼロオーバヘッド） |
| `ANATOMIA_SESSION_ID` | transcript の session タグを上書き（Lictor 等のラッパが端末セッションと cache イベントを対応付けるため）。未設定は `pid-時刻` を自動採番 |

**キャッシュ命中率の計測:** `ANATOMIA_CACHE_DIR`（永続）+ `ANATOMIA_CACHE_LOG`（transcript）を設定して
MCP 経路で verify/analyze を回し、`node bin/anatomia.mjs cache-stats` で global / namespace 別 /
session 別の hit 率と節約コールを見る。詳細は [`docs/cache-measurement.md`](./docs/cache-measurement.md)。

---

## クイックスタート

```sh
# プロジェクトを登録して解析（Merkle キャッシュが効く）
node bin/anatomia.mjs project add adventure <path-to-repo>
node bin/anatomia.mjs project analyze adventure

# 生成前: タスクの文脈束を組む
node bin/anatomia.mjs context --project adventure --task "freeze effect を追加"

# 生成後: diff を 5 ゲートで検証（block 失敗で exit 1）
git diff | node bin/anatomia.mjs verify --project adventure --json
```

単発（登録なし）は `--repo <path>`、静的グラフは `export-graph -o graph.html`、
複数プロジェクト管理 UI は `web --port 4200`。

**詳しい解析手順は [`spec/feature/analysis-procedure.md`](./spec/feature/analysis-procedure.md)。**

---

## AI への接続

生成前 supply / 生成後 verify を AI ホストから回す経路は 2 つ。

- **MCP（常駐サーバ）** — `.mcp.json` に `bin/anatomia-mcp.mjs` を登録し 11 ツールを公開。
  設定は [`docs/mcp-setup.md`](./docs/mcp-setup.md)。
- **Skill（MCP 不要・CLI ラッパ）** — Claude Code のスキル `anatomia-analyze` から CLI を直接叩く。
  常駐プロセス不要。`spec/feature/analysis-procedure.md` §4 参照。

---

## ライセンス

LUDIARS internal（private）。
