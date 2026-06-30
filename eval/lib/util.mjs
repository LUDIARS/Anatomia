// 共通ユーティリティ。
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';

// Windows: `.cmd` シム (npm/npx) は CreateProcess が .exe を付けるため見つからない。
// claude/node/git は .exe があるのでそのまま動く。
function exe(cmd) {
  if (process.platform !== 'win32') return cmd;
  if (cmd === 'npm') return 'npm.cmd';
  if (cmd === 'npx') return 'npx.cmd';
  return cmd;
}

/** 同期実行。非ゼロでも throw せず {code, stdout, stderr} を返す。 */
export function sh(cmd, args, opts = {}) {
  const resolved = exe(cmd);
  // Node 18+ は .cmd を shell 無しで spawn 不可 (EINVAL)。npm/npx は shell:true。
  const shell = process.platform === 'win32' && resolved.endsWith('.cmd');
  const r = spawnSync(resolved, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell, ...opts });
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error) : '') };
}

/** 非同期実行 (stdin 入力 + タイムアウト)。{code, stdout, stderr, timedOut, wallMs} を返す。 */
export function run(cmd, args, { input, timeoutMs, cwd, env } = {}) {
  return new Promise((res) => {
    const t0 = Date.now();
    const child = spawn(exe(cmd), args, { cwd, env, windowsHide: true });
    let stdout = '', stderr = '', timedOut = false;
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs) : null;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { if (timer) clearTimeout(timer); res({ code: code ?? 1, stdout, stderr, timedOut, wallMs: Date.now() - t0 }); });
    child.on('error', (e) => { if (timer) clearTimeout(timer); res({ code: 1, stdout, stderr: String(e), timedOut, wallMs: Date.now() - t0 }); });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

export function ensureDir(p) { if (!existsSync(p)) mkdirSync(p, { recursive: true }); }
export function readText(p) { return existsSync(p) ? readFileSync(p, 'utf8') : ''; }
export function readJSON(p, fallback = null) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } }
export function readJSONL(p) {
  return readText(p).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
/** 数行 JSONL を集計用に。 */
export function sum(arr, f) { return arr.reduce((a, x) => a + (f(x) || 0), 0); }
