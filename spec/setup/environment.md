# setup: 環境・依存・環境変数

## 必要環境

- **Node.js 20+**（ESM / `package.json` `"type": "module"`）。
- ネイティブ/WASM 依存（`kuzu`, `web-tree-sitter` / `tree-sitter-wasms`）を含むため、初回は
  `npm install` でビルドが走る。
- `redis` は **optionalDependency**（共有キャッシュを Redis に置くときだけ要る。未導入でも動く）。

## インストール & ビルド

```sh
git clone https://github.com/LUDIARS/Anatomia.git
cd Anatomia
npm install
npm run build      # tsc → dist/  （bin は dist/ をロードするため必須）
```

CLI / MCP の入口（`bin/anatomia.mjs` / `bin/anatomia-mcp.mjs`）は `.ts` ソースではなく
`dist/` を読む。**コード変更後は必ず `npm run build`**。

## npm スクリプト

| コマンド | 内容 |
|---|---|
| `npm run build` | `tsc` で `dist/` を生成 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `vitest run`（全テスト） |
| `npm run measure` | `node scripts/measure.mjs`（ハッシュ命中率 / 束決定性 / verify 精度） |

## 環境変数

### Anatomia home / プロジェクト
| 変数 | 効果 |
|---|---|
| `ANATOMIA_HOME` | レジストリ（`projects.json`）と増分キャッシュ（`cache/`）の置き場所。未設定は `<cwd>/.anatomia`。`web --home <dir>` で上書き可（→ data/project-cache.md） |
| `ANATOMIA_PLUGIN_DIR` | ドメインオントロジー plugin dir（`.json` / `.mjs`）。プロジェクト単位の `ontologyDir` でも指定可（→ feature/domain-detection.md） |

### 実 LLM / embedder（任意）
未設定なら hash-embedder + mock カードで動作（hermetic・API 不要）。実プロバイダを入れると
duplication ゲートが「車輪の再発明」を実検出する。

| 変数 | 効果 |
|---|---|
| `ANTHROPIC_API_KEY` | LLM 蒸留を有効化（既定モデル `claude-opus-4-8`） |
| `ANATOMIA_LLM_MODEL` | LLM モデル上書き |
| `ANATOMIA_EMBED_BASE_URL` / `_API_KEY` / `_MODEL` / `_DIM` | OpenAI 互換 embedder（ローカル Ollama 可） |

### キャッシュ backend（優先度 = Redis > File > memory、→ data/llm-cache.md）
| 変数 | 効果 |
|---|---|
| `ANATOMIA_CACHE_REDIS` | `redis://…`。LLM 蒸留キャッシュを Redis（org 横断共有）に置く。`redis` 未導入/到達不可なら無言で no-op に degrade |
| `ANATOMIA_CACHE_REDIS_TTL` | Redis 保持上限（秒） |
| `ANATOMIA_CACHE_DIR` | LLM 蒸留キャッシュを per-machine 永続 file store（content-addressed）に置く。未設定はプロセス内メモリ（hermetic） |

### キャッシュ計測（任意）
| 変数 | 効果 |
|---|---|
| `ANATOMIA_CACHE_LOG` | cache の hit/miss と LLM token 使用量を JSONL transcript に追記（MCP / web 経路）。`anatomia cache-stats` で集計。未設定は計測 off（ゼロオーバヘッド） |
| `ANATOMIA_SESSION_ID` | transcript の session タグ上書き（Lictor 等が端末セッションと cache イベントを対応付ける）。未設定は `pid-時刻` を自動採番 |

## 起動経路

- **CLI**: `node bin/anatomia.mjs <subcommand>`（→ interface/cli.md）。
- **MCP（常駐）**: `.mcp.json` に `bin/anatomia-mcp.mjs` を登録（→ interface/mcp.md、`docs/mcp-setup.md`）。
- **Web パネル（常駐）**: `node bin/anatomia.mjs web --port 4200 [--home <dir>]`（→ interface/web.md）。

詳細な解析手順は [feature/analysis-procedure.md](../feature/analysis-procedure.md)。
