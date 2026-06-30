#!/usr/bin/env node
// 実験2+3: 4アーム × 3モデル × K反復を逐次実行し、各 run を独立レビュアで採点。
// 結果は results/ + Review/Anatomia-eval/<date>/ に集約。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.mjs';
import { ensureDir } from '../lib/util.mjs';
import { baseCommit } from '../lib/workspace.mjs';
import { executeRun } from '../lib/run.mjs';
import { gradeRun } from '../lib/grade.mjs';
import { aggregate } from '../lib/aggregate.mjs';

const BASE = `http://127.0.0.1:${config.port}`;
async function serverUp() { try { return !!(await fetch(`${BASE}/api/projects`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } }

async function main() {
  if (!(await serverUp())) { console.error('warm サーバが居ません。先に `node bin/setup.mjs`'); process.exit(1); }
  const baseFile = resolve(config.evalRoot, 'base.txt');
  const base = existsSync(baseFile) ? readFileSync(baseFile, 'utf8').trim() : baseCommit(config.workspace);
  ensureDir(config.resultsDir);

  const plan = [];
  for (const model of config.models) for (const arm of config.arms) for (let rep = 1; rep <= config.repeats; rep++) {
    plan.push({ model, arm, rep, runId: `${model}__${arm}__r${rep}`.replace(/[^A-Za-z0-9_.-]/g, '-') });
  }
  const only = process.env.EVAL_ONLY; // 部分実行: 部分文字列フィルタ
  const runs = only ? plan.filter((p) => p.runId.includes(only)) : plan;
  console.log(`[eval] ${runs.length} runs (base ${base.slice(0, 8)})`);

  const manifest = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const t0 = Date.now();
    process.stdout.write(`[eval] (${i + 1}/${runs.length}) ${r.runId} … `);
    let rec, grade;
    try { rec = await executeRun({ ...r, base }); }
    catch (e) { console.log('RUN ERR', e.message); manifest.push({ ...r, error: String(e) }); continue; }
    // run 直後 (次の reset 前) に採点。workspace が当該 run の状態のまま
    try { grade = await gradeRun(rec); }
    catch (e) { grade = { graded: false, reason: 'grade err: ' + e.message }; }
    const s = Math.round((Date.now() - t0) / 1000);
    console.log(`${rec.ok ? 'ok' : 'FAIL'} diff:${rec.diffEmpty ? 'empty' : rec.diffLines + 'L'} turns:${rec.agent?.numTurns ?? '-'} over:${Math.round((rec.anatomiaOverheadMs || 0))}ms grade:${grade?.graded ? 'ok' : 'no'} (${s}s)`);
    manifest.push({ ...r, ok: rec.ok, diffEmpty: rec.diffEmpty, graded: !!grade?.graded });
    writeFileSync(resolve(config.resultsDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  }

  console.log('[eval] 集計 …');
  const { reviewDir } = aggregate();
  console.log('[eval] 完了。scoreboard:', resolve(config.resultsDir, 'scoreboard.md'));
  console.log('[eval] Review 集約:', reviewDir);
}

main().catch((e) => { console.error('[eval] FAILED:', e.message); process.exit(1); });
