# data: 共有 content-addressed LLM 蒸留キャッシュ（A-3）

LLM 蒸留（ドメインカード / phase ラベル）の結果を保存する content-addressed キャッシュ。
同一コード/局面はどこでも同一キーになるため、呼び出し・セッション・リポ・マシンを跨いで
共有・命中する。実装は `src/cache/`。

## バックエンド選択

`resolveCacheStore()`（`src/cache/resolve.ts`）が環境変数から選ぶ。**優先度 = Redis > File > memory**。

| backend | 条件 | 実装 | 性質 |
|---|---|---|---|
| Redis | `ANATOMIA_CACHE_REDIS`（`redis://…`） | `redis-store.ts` | org 横断共有。`redis` は optionalDependency、未導入/到達不可なら無言で no-op に degrade。`ANATOMIA_CACHE_REDIS_TTL`（秒）で保持上限 |
| File | `ANATOMIA_CACHE_DIR`（dir） | `file-store.ts` | per-machine 永続。`<dir>/<key>.json` 1 ファイル/キー |
| memory | 上記いずれも無し | `store.ts` `createMemoryStore` | プロセス内 Map（hermetic 既定） |

## キー構造

`versionedKey(contentKey, modelId, templateVersion)`（`src/cache/store.ts`）。
3 要素をスペース連結して SHA-256 hex 化（file store のファイル名にも安全）。

```
key = sha256( `${contentKey} ${modelId} ${templateVersion}` )
```

- `contentKey`: 蒸留対象の内容ハッシュ（ドメイン/局面）。
- `modelId`: 使用 LLM モデル id。
- `templateVersion`: プロンプトテンプレ版。

→ モデルやプロンプトを変えると別キーになり、**stale を返さない**。値は immutable
（content-addressed）なので、複数セッションの並行書き込みも同一キー→同一値で衝突しない。
File store の書き込みは tmp + rename で atomic、壊れた/読めないエントリは crash せず miss 扱い。

## File store のレイアウト

```
$ANATOMIA_CACHE_DIR/
└── <versionedKey>.json     # 蒸留結果 V を JSON.stringify したもの
```

ディレクトリは初回書き込みで lazy 作成。namespace は `card`（ドメインカード）/
`phase`（局面ラベル）。

## 計測トランスクリプト（任意）

`ANATOMIA_CACHE_LOG` を設定すると、cache GET（hit/miss）と実 LLM 呼び出しを
JSONL transcript に追記する（`src/cache/transcript.ts`）。MCP / web 経路で
store を `instrumentStore` でラップして記録する。

### GetEvent（1 行 = 1 回の cache GET）

| フィールド | 型 | 意味 |
|---|---|---|
| `kind` | `"get"` | 種別 |
| `ts` | `number` | epoch ms |
| `session` | `string` | セッション id（`ANATOMIA_SESSION_ID` 上書き可、未設定は `pid-時刻`） |
| `ns` | `"card" \| "phase"` | namespace |
| `hit` | `boolean` | hit=store から、miss=LLM 呼び出し |
| `key` | `string` | versioned key（sha256 hex） |
| `model?` | `string` | キーに畳み込んだモデル id（診断用） |

### LlmEvent（cache miss で発生した実 LLM 呼び出し）

| フィールド | 型 | 意味 |
|---|---|---|
| `kind` | `"llm"` | 種別 |
| `ts` / `session` / `model` | — | 同上 |
| `usage` | `LlmUsage` | `inputTokens / outputTokens / cacheReadTokens / cacheCreationTokens`（Anthropic Messages usage） |

集計は `cache-stats`（→ [interface/cli.md](../interface/cli.md)）/ `src/cache/stats.ts` が
global / namespace 別 / session 別 hit 率と節約コール数を出す。記録は fire-and-forget で
解析を壊さない（書き込みエラーは握りつぶす）。
