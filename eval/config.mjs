// anatomia-eval — 実験設定。env で上書き可。
import { resolve } from 'node:path';

const ARS = process.env.ARS_ROOT || 'E:/Document/Ars';

export const config = {
  // パス
  arsRoot: ARS,
  // eval 専用の最新 Anatomia (origin/main の detached worktree)。共有 dev checkout が
  // 並行作業で stale でも影響を受けない (feedback_stale_local_main_consumer_ref)。
  anatomiaSource: `${ARS}/Anatomia`,
  get anatomiaHome() { return resolve(this.evalRoot, 'anatomia'); },
  hooksDir: `${ARS}/.claude/hooks`,
  // Concordia の元 (ローカル dev checkout から clone)
  sourceRepo: process.env.EVAL_SOURCE_REPO || `${ARS}/Concordia`,
  // 評価用ワークスペース (Ars 外 = グローバル Ars フック非適用)
  evalRoot: process.env.EVAL_ROOT || 'E:/anatomia-eval',
  get workspace() { return resolve(this.evalRoot, 'ws/concordia'); },
  get resultsDir() { return resolve(this.evalRoot, 'results', this.task); },
  get settingsDir() { return resolve(this.evalRoot, '.run-settings'); },
  // warm サーバが書く共有キャッシュ transcript (run 区間で snapshot して集計)
  get cacheLog() { return resolve(this.evalRoot, 'cache-transcript.jsonl'); },

  // warm Anatomia web サーバ
  port: Number(process.env.ANATOMIA_PORT || '4200'),
  anatomiaProjectId: process.env.EVAL_PROJECT_ID || 'concordia-eval',
  cacheDir: process.env.ANATOMIA_CACHE_DIR || resolve(ARS, 'Anatomia/.eval-cache'),

  // 実験マトリクス
  arms: ['off', 'supply', 'verify', 'both'],
  models: (process.env.EVAL_MODELS || 'claude-haiku-4-5,claude-sonnet-4-6,claude-opus-4-8').split(','),
  repeats: Number(process.env.EVAL_REPEATS || '3'),
  graderModel: process.env.EVAL_GRADER_MODEL || 'claude-opus-4-8',

  // 1 run のタイムアウト (ms)
  runTimeoutMs: Number(process.env.EVAL_RUN_TIMEOUT_MS || String(20 * 60 * 1000)),

  // タスク / ルーブリック (EVAL_TASK で切替: task/<name>.md + task/<name>.rubric.json)
  task: process.env.EVAL_TASK || 'concordia-paused',
  get taskFile() { return resolve(this.evalRoot, `task/${this.task}.md`); },
  get rubricFile() { return resolve(this.evalRoot, `task/${this.task}.rubric.json`); },

  // git-bash (Node から claude spawn に必須)。env 優先、無ければこのマシンの実在パス。
  gitBash: process.env.CLAUDE_CODE_GIT_BASH_PATH
    || 'C:/Users/raury/AppData/Local/Atlassian/SourceTree/git_local/usr/bin/bash.exe',
};

/** arm → 有効フック + env ゲート。 */
export function armConfig(arm) {
  return {
    off: { supply: false, verify: false, hooks: false },
    supply: { supply: true, verify: false, hooks: true },
    verify: { supply: false, verify: true, hooks: true },
    both: { supply: true, verify: true, hooks: true },
  }[arm];
}
