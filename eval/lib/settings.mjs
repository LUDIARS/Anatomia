// arm 別の claude --settings ファイルを生成。anatomia フックだけを注入する
// (workspace は Ars 外なのでグローバル Ars フックは適用されない)。
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { armConfig, config } from '../config.mjs';
import { ensureDir } from './util.mjs';

/**
 * arm の settings.json を書き出してパスを返す。supply は UserPromptSubmit、
 * verify は PostToolUse(Edit|Write|MultiEdit)。off は空。
 */
export function writeArmSettings(arm) {
  const a = armConfig(arm);
  const supplyCmd = `node "${config.hooksDir}/anatomia-supply.mjs"`;
  const verifyCmd = `node "${config.hooksDir}/anatomia-verify.mjs"`;
  const settings = { hooks: {} };
  if (a.supply) {
    settings.hooks.UserPromptSubmit = [{ hooks: [{ type: 'command', command: supplyCmd, timeout: 15 }] }];
  }
  if (a.verify) {
    settings.hooks.PostToolUse = [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: verifyCmd, timeout: 15 }] }];
  }
  ensureDir(config.settingsDir);
  const path = resolve(config.settingsDir, `${arm}.settings.json`);
  writeFileSync(path, JSON.stringify(settings, null, 2), 'utf8');
  return path;
}

/** arm + 計測ログパスから claude spawn 用 env を組む。 */
export function armEnv(arm, { hookLog, cacheLog }) {
  const a = armConfig(arm);
  const env = {
    ...process.env,
    CLAUDE_CODE_GIT_BASH_PATH: config.gitBash,
    ANATOMIA_PORT: String(config.port),
    ANATOMIA_HOOKS_LOG: hookLog,
    ANATOMIA_CACHE_LOG: cacheLog,
  };
  // フックは既定 ON (米化) なので、アーム制御は明示的に行う:
  //   off    → ANATOMIA_HOOKS=0 (master kill)
  //   それ以外 → HOOKS=1 + per-hook を SUPPLY/VERIFY=0 で個別 off
  if (a.hooks) {
    env.ANATOMIA_HOOKS = '1';
    env.ANATOMIA_SUPPLY = a.supply ? '1' : '0';
    env.ANATOMIA_VERIFY = a.verify ? '1' : '0';
    // eval は per-edit の挙動を見たいのでデバウンス無効化 (全編集で verify)
    env.ANATOMIA_VERIFY_DEBOUNCE_MS = '0';
  } else {
    env.ANATOMIA_HOOKS = '0';
  }
  return env;
}
