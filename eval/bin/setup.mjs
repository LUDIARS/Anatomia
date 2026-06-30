#!/usr/bin/env node
// 一回限りのセットアップ: 最新 Anatomia worktree 構築 → 起動 → Concordia clone →
// project 登録 → pre-warm。実行後 run-eval / cache-microbench が回せる状態にする。
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.mjs';
import { sh, ensureDir, run } from '../lib/util.mjs';
import { ensureClone, ensureDeps, baseCommit } from '../lib/workspace.mjs';

const BASE = `http://127.0.0.1:${config.port}`;

async function serverUp() { try { return !!(await fetch(`${BASE}/api/projects`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } }
async function waitUp(timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (await serverUp()) return true; await new Promise((r) => setTimeout(r, 1500)); }
  return false;
}

async function main() {
  ensureDir(config.evalRoot); ensureDir(config.resultsDir);

  // 1) 最新 Anatomia worktree (origin/main detached) + node_modules junction + build
  if (!existsSync(`${config.anatomiaHome}/.git`)) {
    console.log('[setup] Anatomia worktree (origin/main) 作成');
    sh('git', ['-C', config.anatomiaSource, 'fetch', 'origin', '-q']);
    const r = sh('git', ['-C', config.anatomiaSource, 'worktree', 'add', '--detach', config.anatomiaHome, 'origin/main']);
    if (r.code !== 0) throw new Error('worktree add failed: ' + r.stderr);
    if (!existsSync(`${config.anatomiaHome}/node_modules`)) {
      sh('cmd', ['/c', 'mklink', '/J', config.anatomiaHome.replace(/\//g, '\\') + '\\node_modules', config.anatomiaSource.replace(/\//g, '\\') + '\\node_modules']);
    }
  } else {
    sh('git', ['-C', config.anatomiaSource, 'fetch', 'origin', '-q']);
    sh('git', ['-C', config.anatomiaHome, 'reset', '--hard', 'origin/main']);
  }
  console.log('[setup] Anatomia build');
  const b = sh('npm', ['run', 'build', '--prefix', config.anatomiaHome], { cwd: config.anatomiaHome });
  if (b.code !== 0) throw new Error('anatomia build failed: ' + b.stderr.slice(-1500));

  // 2) Concordia clone + deps + BASE
  console.log('[setup] Concordia clone + deps');
  ensureClone(config);
  const dep = ensureDeps(config.workspace);
  if (dep.installed && dep.code !== 0) console.warn('[setup] npm install 警告: ' + (dep.stderr || ''));
  const base = baseCommit(config.workspace);
  writeFileSync(resolve(config.evalRoot, 'base.txt'), base, 'utf8');
  console.log('[setup] BASE =', base);

  // 3) warm サーバ起動 (実プロバイダ + 永続キャッシュ + transcript)
  if (!(await serverUp())) {
    if (!process.env.ANTHROPIC_API_KEY) console.warn('[setup] ⚠ ANTHROPIC_API_KEY 未設定 — ①キャッシュ/②duplication は stub になります');
    ensureDir(config.cacheDir);
    const logPath = resolve(config.evalRoot, 'server.log');
    console.log('[setup] warm サーバ起動 (port ' + config.port + '), log:', logPath);
    const out = (await import('node:fs')).openSync(logPath, 'a');
    const child = spawn('node', [`${config.anatomiaHome}/bin/anatomia.mjs`, 'web', '--port', String(config.port)], {
      cwd: config.anatomiaHome, detached: true, stdio: ['ignore', out, out],
      env: { ...process.env, ANATOMIA_CACHE_LOG: config.cacheLog, ANATOMIA_CACHE_DIR: config.cacheDir, ANATOMIA_SESSION_ID: 'eval-server' },
    });
    child.unref();
    if (!(await waitUp())) throw new Error('server did not come up — see ' + logPath);
  }
  console.log('[setup] server up');

  // 4) project 登録 (warm サーバへ POST、即反映)
  const reg = await run('node', ['-e', `fetch('${BASE}/api/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'${config.anatomiaProjectId}',rootPath:${JSON.stringify(config.workspace)}})}).then(r=>r.text()).then(t=>console.log(t)).catch(e=>{console.error(e);process.exit(1)})`], { timeoutMs: 300000 });
  console.log('[setup] project 登録:', reg.stdout.trim().slice(0, 200));

  // 5) pre-warm (初回 analyze を済ませる)
  console.log('[setup] pre-warm /api/context ...');
  await run('node', ['-e', `fetch('${BASE}/api/context?project=${config.anatomiaProjectId}&task=warmup').then(r=>r.json()).then(b=>console.log('domains:',(b.existingDomains||[]).length,'exemplars:',(b.exemplars||[]).length)).catch(e=>console.error(String(e)))`], { timeoutMs: 600000 });

  console.log('\n[setup] 完了。次:\n  node bin/cache-microbench.mjs\n  node bin/run-eval.mjs');
}

main().catch((e) => { console.error('[setup] FAILED:', e.message); process.exit(1); });
