# anatomia-eval — Anatomia ハーネス統合の評価ハーネス

3 つの差分を 1 つのタスクから測る最大設計の実験ランナー。

- **① LLM キャッシュのコスト削減** — Anatomia の蒸留呼び出しを cache ON/OFF で比較（`bin/cache-microbench.mjs`）。
- **② supply→verify による AI 動作の質の向上** — 同一タスクを 4 アームで回し、独立レビュアが採点。
- **③ Anatomia 介在による速度** — フック自己計測の遅延（追加コスト）と反復削減（手戻り短縮）に分解。

## 構成

- **対象コードベース**: Concordia（TS・強い不変条件・文書化された footgun）。専用 clone を `ws/concordia` に作り、run 間で `git reset --hard BASE` で隔離（実 dev checkout は触らない）。
- **タスク**: `task/concordia-paused.md`（per-session `paused` フラグ追加）。kill-switch パターンへの寄せ／footgun を自然に踏む設計。
- **アーム**: `off` / `supply` / `verify` / `both`。
- **モデル**: `claude-haiku-4-5` / `claude-sonnet-4-6` / `claude-opus-4-8`。
- **反復**: `REPEATS`（既定 3）。総 run = 4×3×3 = 36。

## アーム分離

workspace は **Ars 外**（`E:/anatomia-eval/ws`）なので Ars の `.claude/settings.json` フックは適用されない。
各 run は `--settings <arm>.json` で **anatomia フックだけ**を注入し、env でゲート:

| arm | settings に含むフック | env |
|---|---|---|
| off | なし | （ANATOMIA_HOOKS 未設定） |
| supply | anatomia-supply | ANATOMIA_HOOKS=1 |
| verify | anatomia-verify | ANATOMIA_HOOKS=1 |
| both | 両方 | ANATOMIA_HOOKS=1 |

全 run で `ANATOMIA_HOOKS_LOG`（③+verify 捕捉）・`ANATOMIA_CACHE_LOG`（①記録）・`ANATOMIA_PORT` を渡す。

## 計測（run ごと）

- **agent**: `claude -p --output-format json` の `result` から `duration_ms` / `num_turns` / `total_cost_usd` / `usage`。
- **③速度**: `ANATOMIA_HOOKS_LOG` の各フック `ms` 合計（= Anatomia 追加遅延）＋ wall-clock（OFF 比）＋ `num_turns`（手戻りプロキシ）。
- **②品質**: 最終 diff を独立レビュア（`grade.mjs`, Opus）が `task/rubric.json` で採点（footgun 二値＋軸 0–5＋所見）。verify 捕捉は HOOKS_LOG の `fired/gates` から。
- **①キャッシュ**: run 区間の `ANATOMIA_CACHE_LOG` イベントを集計（記述用）。主測定は microbench。

## 前提

- 実プロバイダ（`ANTHROPIC_API_KEY`）— ①が非ゼロになる条件（providers 無しだと蒸留 LLM 呼び出し 0）。
- warm Anatomia web サーバ起動 + `ws/concordia` を project 登録（`bin/setup.mjs`）。
- `CLAUDE_CODE_GIT_BASH_PATH`（Node から claude spawn に必須）。

## 手順

```sh
node bin/setup.mjs            # clone + npm i + Anatomia project 登録 + サーバ確認
node bin/cache-microbench.mjs # 実験1（①）
node bin/run-eval.mjs         # 実験2+3（②③）。結果は results/ → Review/ 集約
```
