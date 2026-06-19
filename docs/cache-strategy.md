# Anatomia キャッシュ戦略 — 作業内容に応じた組み立て

A-3 の LLM 蒸留キャッシュ（ドメインカード / フェーズラベル）は content-addressed で
**セッション・リポ・マシンを跨いで共有**される。ヒット率を上げる = Opus 蒸留呼び出しを
減らす = コストを下げる、が直結する。本ドキュメントは「どの作業でどうキャッシュを作るか」の
設計指針（Opus 設計）と、その効果をどう可視化するか（per-session 帰属 + 想定コスト）を述べる。

関連: [`cache-measurement.md`](./cache-measurement.md)（計測手順）、README「実 LLM / embedder」（env 一覧）。

## キャッシュの 2 層

| 層 | 何が乗るか | キー | コスト |
|---|---|---|---|
| **Merkle DAG**（解析キャッシュ） | 正規化 AST（関数粒度） | 内容ハッシュ | 安い（パースのみ） |
| **LLM 蒸留キャッシュ**（A-3） | ドメインカード / フェーズラベル | 内容 + model + prompt版（`versionedKey`） | **高い**（実 LLM 呼び出し 1 回 / miss） |

最適化対象は後者。1 miss = Opus 蒸留 1 回 ≈ 既定で `claude-opus-4-8` の 1500 in / 400 out
トークン ≈ **$0.0175 / 回**（`cost-estimate.ts`）。

## 作業種別 × キャッシュの作り方（指針）

着手プロンプトの分類（hooks の `TASK_RE`）と作業規模で選ぶ。

| 作業 | backend | pre-warm | 狙い |
|---|---|---|---|
| **軽作業**（1ファイル fix / 小修正） | File（`ANATOMIA_CACHE_DIR`） | 不要 | 既存の蒸留カードに当てる。新規蒸留は最小限 |
| **重作業**（新機能フルセット / 大規模リファクタ） | **Redis 共有**（`ANATOMIA_CACHE_REDIS`） | 着手時に `project analyze` で DAG+カードを温める | 蒸留カードを org 横断で共有しヒット率最大化・Opus コスト最小化 |
| **CI / eval** | File（`ANATOMIA_CACHE_DIR` 固定） | — | 決定性。`ANATOMIA_VERIFY_DEBOUNCE_MS=0` で毎回 verify |

backend 優先度は **Redis > File > memory**（`resolve.ts`）。共有マシンが一度蒸留したカードを
全員が引けるので、重作業ほど共有 backend の効果が大きい。

### 既定の配線（harness）

warm サーバ（`anatomia web`）は hooks が遅延起動し、既定で File backend（`STATE/cache`）+
計測 transcript（`STATE/cache.jsonl`）を持つ。org 共有にするなら warm サーバ起動 env に
`ANATOMIA_CACHE_REDIS=redis://…` を渡す（未到達なら無言で no-op に degrade、安全）。

## per-session 帰属（誰の取り分か）

共有キャッシュゆえ「あるヒットは自分が温めたのか、他セッションの遺産か」が曖昧になる。
warm サーバは単一プロセスなので、何もしないと全イベントが 1 つの process-global session
（`hook-daemon`）でタグされ、セッション別の取り分が消える。

これを解くため、harness ルートが**リクエスト毎に session を受け取り**、その間のキャッシュ
イベントをその session でタグする（`session-context.ts` の `runWithSession`）:

- `POST /api/verify` … body `session`
- `GET /api/context?session=…`

hooks は Lictor が export する `LICTOR_SESSION_ID`（= Concordia session_id）を渡す。
集計は `cache-stats` / `GET /api/cache-stats?session=<id>` が global / namespace / session 別に返す。

## 想定コストの出し方（無課金でも意味を持たせる）

実コストは warm サーバに API キーがある時だけ実トークンで出る。多くの harness 経路は
stub-llm（無課金）なので、`cost-estimate.ts` は:

- 実 LLM イベントがある → **実測**平均トークンで per-call コスト（`basis: "measured"`）
- 無い（stub） → **想定**トークン（既定 1500/400、env 上書き可）で推定（`basis: "assumed"`、`~` 表記）

から、per-session / global で:

- **想定節約** = hits × per-call（キャッシュが避けた額）
- **想定コスト** = misses × per-call（実走した蒸留の額）
- **キャッシュ無し** = (hits+misses) × per-call

を出す。料金は既定 `claude-opus-4-8`（$5/$25 per Mtok）、`ANATOMIA_COST_*` env で上書き。

## env まとめ（コスト/帰属まわり）

| 変数 | 既定 | 効果 |
|---|---|---|
| `ANATOMIA_COST_MODEL` | `claude-opus-4-8` | 表示する蒸留モデル名 |
| `ANATOMIA_COST_INPUT_PER_MTOK` / `_OUTPUT_PER_MTOK` | `5` / `25` | 100万トークン単価（USD） |
| `ANATOMIA_COST_CALL_INPUT_TOKENS` / `_OUTPUT_TOKENS` | `1500` / `400` | 蒸留 1 回の想定トークン（実 LLM が無い時のみ使用） |

（共有 backend / transcript の env は README・`cache-measurement.md` を参照）
