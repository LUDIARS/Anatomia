# Anatomia — LLM キャッシュ命中率の計測（A-3 measurement）

A-3 の LLM 蒸留キャッシュ（ドメインカード / フェーズラベル）は **content-addressed で
セッション・リポ・マシンを跨いで共有**される（`ANATOMIA_CACHE_DIR` の file store）。
共有されることが利点だが、同時に「ある端末セッションから見て、キャッシュが効いているか」を
判断しづらくする — ヒットは自分のセッションが温めた成果かもしれないし、過去の別セッションが
残したものかもしれない。本ドキュメントはそれを **定量化**する手順。

## 何が計測されるか

`ANATOMIA_CACHE_LOG` を設定すると、MCP サーバ経路の各操作が JSONL transcript に
1 行ずつ追記される。

| イベント | 意味 |
|---|---|
| `{"kind":"get","ns":"card"|"phase","hit":true|false,"session":...,"key":...}` | キャッシュ参照 1 回。`hit=true` = LLM を呼ばず即返却 / `hit=false` = この後 LLM を 1 回呼ぶ |
| `{"kind":"llm","model":...,"usage":{inputTokens,outputTokens,cacheReadTokens,cacheCreationTokens}}` | 実 LLM 呼び出し 1 回（= miss が到達した先）。Anthropic prompt-cache の read/creation token も記録 |

各行は **per-process の session id** でタグされる（`ANATOMIA_SESSION_ID` で上書き可。
Lictor のようなラッパが端末セッションと対応付けるため）。複数セッションが同じファイルに
追記し、`cache-stats` が読み戻して集計する（小さい行の O_APPEND atomic 追記）。

## 重要な前提（どの経路で効くか）

- LLM キャッシュ（A-3）を**実際に行使するのは MCP サーバ経路だけ**。CLI の `verify` は
  providers を渡さないため LLM キャッシュを経由しない（duplication ゲートは mock）。
  → 計測したいなら **MCP 経由**（`bin/anatomia-mcp.mjs`）で verify/analyze を回す。
- `ANATOMIA_CACHE_DIR` を設定しないと cache はプロセス内メモリで、CLI 呼び出しを跨いだ
  ヒットは起こらない。**セッション共有の命中率を見たいなら DIR + LOG の両方**を設定する。
- 計測は env 未設定なら完全に off（transcript は no-op、オーバヘッドゼロ、テストは hermetic）。

## 手順

```sh
export ANATOMIA_CACHE_DIR="$HOME/.anatomia/cache"     # 永続・共有ストア
export ANATOMIA_CACHE_LOG="$HOME/.anatomia/cache.jsonl" # 計測 transcript
export ANTHROPIC_API_KEY=sk-...                        # 実 LLM（token を載せたい場合）

# MCP サーバを AI ホスト（Claude Code / Concordia 等）に接続して verify/analyze を回す
#   → 例えば同じ diff を複数セッションで verify すると、2 回目以降は cache hit になる

# 命中率を集計
node bin/anatomia.mjs cache-stats                      # $ANATOMIA_CACHE_LOG を読む
node bin/anatomia.mjs cache-stats --log /path/x.jsonl  # 明示パス
node bin/anatomia.mjs cache-stats --json               # 機械可読
```

### 出力例

```
Anatomia LLM cache — hit rate

  GLOBAL                        4/6      hit  (66.7%)

by namespace:
  card                          4/6      hit  (66.7%)

by session:
  smoke-A                       4/6      hit  (66.7%)

LLM calls made:        0
  calls saved (hits):  4
  tokens in/out:       0 / 0 (prompt-cache read 0, create 0)
  est. tokens saved:   ~0 (hits × mean call size)
```

- **GLOBAL** = 共有キャッシュ全体の命中率（全セッション合算）。
- **by session** = 各セッションの取り分。「このセッションは得をしたのか、それとも後続の
  ために温めただけか」を切り分ける。
- **calls saved** = ヒット数（各ヒットが LLM 呼び出しを 1 回回避）。
- **est. tokens saved** = ヒット数 × 実際に行われた呼び出しの平均トークン。回避された
  呼び出しは定義上行われていないので **推定値**。

## Anthropic prompt cache（③）について

`usage.cacheReadTokens` / `cacheCreationTokens` で Anthropic 側の prompt cache も観測できるが、
ドメインカード蒸留はプロンプト本文が毎回ユニーク（固定の system prompt は ~80 token で
最小キャッシュ単位未満）なので、このワークロードでは prompt cache はほぼ効かない見込み。
意味のある指標は **②（Anatomia 自身の content-addressed cache）の命中率**。transcript で
③ の token を併記するのは「効いていない」ことを実測で示すため。

## 関連

- 実装: `src/cache/transcript.ts`（イベント / JSONL）, `src/cache/instrumented.ts`（hit/miss 記録）,
  `src/cache/stats.ts`（集計）, `src/providers/anthropic-llm.ts`（usage 捕捉）。
- 設計: DESIGN §4.4 / §9（A-3 共有キャッシュ）。
