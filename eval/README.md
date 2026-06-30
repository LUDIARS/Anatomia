# anatomia-eval

Anatomia ハーネス統合（supply→verify フック＋共有キャッシュ）の効果を 3 軸で測る評価ハーネス。
設計の詳細は [`DESIGN.md`](./DESIGN.md)。

測る差分:
1. **① LLM キャッシュのコスト削減** — `bin/cache-microbench.mjs`
2. **② supply→verify による品質向上** — `bin/run-eval.mjs`（4アーム）
3. **③ Anatomia 介在による速度** — 同 run のフック遅延 + wall-clock 分解

## 実行

```sh
# 1) 前提: 実プロバイダ (①②duplication が非ゼロになる条件)
export ANTHROPIC_API_KEY=sk-...
# Node から claude を spawn するのに必須
export CLAUDE_CODE_GIT_BASH_PATH="C:/Program Files/Git/bin/bash.exe"

# 2) セットアップ (最新Anatomia worktree+build / Concordia clone+deps / warmサーバ起動 / project登録 / pre-warm)
node bin/setup.mjs

# 3) 実験1 — キャッシュ削減
node bin/cache-microbench.mjs

# 4) 実験2+3 — 品質 × 速度 (4アーム×3モデル×K反復、逐次)
node bin/run-eval.mjs
# 部分実行: EVAL_ONLY=haiku EVAL_REPEATS=1 node bin/run-eval.mjs
```

結果: `results/scoreboard.md`（+ `Review/Anatomia-eval/<date>/`）。各 run の生成物は `results/<runId>/`（diff.patch / record.json / grade.json / claude-stdout.json）。

## 主な環境変数

| 変数 | 既定 | 効果 |
|---|---|---|
| `EVAL_MODELS` | haiku,sonnet,opus | 評価モデル（カンマ区切り） |
| `EVAL_REPEATS` | 3 | 反復数 |
| `EVAL_GRADER_MODEL` | claude-opus-4-8 | 採点モデル |
| `EVAL_ONLY` | — | runId 部分一致でフィルタ（部分実行） |
| `EVAL_RUN_TIMEOUT_MS` | 1200000 | 1 run の上限 |
| `ANATOMIA_PORT` | 4200 | warm サーバ port |
| `MICROBENCH_K` | 6 | microbench の verify 回数/phase |

## 注意

- warm サーバは setup が detached 起動（`server.log`）。停止は port 4200 の node を kill。
  **setup は既に起動中のサーバを再利用する**ので、`ANTHROPIC_API_KEY` を後から有効化したいときは
  先に port 4200 の node を kill してから `ANTHROPIC_API_KEY=... node bin/setup.mjs`（鍵付きで新規起動）。
- ワークスペース `ws/concordia` は専用 clone（実 dev checkout は触らない）。run 間で `git reset --hard BASE`。
- Anatomia は `anatomia/`（origin/main の detached worktree）を使う＝共有 dev checkout の stale 影響を受けない。
