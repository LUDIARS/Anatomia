// Concordia 評価ワークスペースの clone / reset。実 dev checkout は触らない。
import { existsSync } from 'node:fs';
import { sh } from './util.mjs';

/** source からローカル clone。既存ならスキップ。 */
export function ensureClone(config) {
  const ws = config.workspace;
  if (existsSync(`${ws}/.git`)) return { cloned: false, ws };
  const r = sh('git', ['clone', config.sourceRepo, ws]);
  if (r.code !== 0) throw new Error(`clone failed: ${r.stderr}`);
  return { cloned: true, ws };
}

/** 現在の HEAD を BASE として返す。 */
export function baseCommit(ws) {
  return sh('git', ['-C', ws, 'rev-parse', 'HEAD']).stdout.trim();
}

/** run 間の隔離: BASE へ hard reset + clean (node_modules は温存)。 */
export function resetTo(ws, base) {
  sh('git', ['-C', ws, 'reset', '--hard', base]);
  sh('git', ['-C', ws, 'clean', '-fdx', '-e', 'node_modules', '-e', '.run-*']);
}

/** run 後の diff (BASE 比、全変更)。 */
export function captureDiff(ws, base) {
  // untracked も含めるため add -N してから diff
  sh('git', ['-C', ws, 'add', '-AN']);
  return sh('git', ['-C', ws, 'diff', base]).stdout;
}

/** npm install (初回のみ)。 */
export function ensureDeps(ws) {
  if (existsSync(`${ws}/node_modules`)) return { installed: false };
  const r = sh('npm', ['install', '--prefix', ws, '--no-audit', '--no-fund'], { cwd: ws });
  return { installed: true, code: r.code, stderr: r.stderr.slice(-2000) };
}
