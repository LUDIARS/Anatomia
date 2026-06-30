#!/usr/bin/env node
// 実験1 (①): Anatomia 蒸留キャッシュのコスト削減を cache OFF/ON で対比。
//
// verify は project の既存ドメインを蒸留 (duplication gate)。同じ verify を K 回:
//   - noCache: 毎回キャッシュをクリア → 毎回再蒸留 (cache 無しのコスト)
//   - withCache: 最初だけクリア → 1 回目のみ蒸留、以降 hit
// cache transcript の llm イベント数/token を phase ごとに集計して比較。
import { existsSync, readFileSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.mjs';
import { ensureDir } from '../lib/util.mjs';

const BASE = `http://127.0.0.1:${config.port}`;
const K = Number(process.env.MICROBENCH_K || '6');
const DIFF = 'export function __probe(n: number): number { let t = 0; for (let i = 0; i < n; i++) t += i; return t; }';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function clearCache() { try { for (const f of readdirSync(config.cacheDir)) if (f.endsWith('.json')) rmSync(resolve(config.cacheDir, f)); } catch { /* */ } }
function txLen() { try { return readFileSync(config.cacheLog, 'utf8').split(/\r?\n/).filter((l) => l.trim()).length; } catch { return 0; } }
function txSlice(from) {
  try {
    return readFileSync(config.cacheLog, 'utf8').split(/\r?\n/).filter((l) => l.trim()).slice(from)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
async function verify() {
  try {
    const r = await fetch(`${BASE}/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ diff: DIFF, project: config.anatomiaProjectId, targetPath: 'src/__probe.ts' }), signal: AbortSignal.timeout(120000) });
    return r.ok;
  } catch { return false; }
}
function agg(events) {
  const gets = events.filter((e) => e.kind === 'get'); const llm = events.filter((e) => e.kind === 'llm');
  const hits = gets.filter((e) => e.hit).length;
  return { gets: gets.length, hits, misses: gets.length - hits, hitRate: gets.length ? +(hits / gets.length).toFixed(3) : 0,
    llmCalls: llm.length, inputTokens: llm.reduce((a, e) => a + (e.usage?.inputTokens || 0), 0), outputTokens: llm.reduce((a, e) => a + (e.usage?.outputTokens || 0), 0) };
}

async function phase(name, clearEach) {
  clearCache();
  const from = txLen();
  for (let i = 0; i < K; i++) { if (clearEach) clearCache(); await verify(); await sleep(150); }
  await sleep(400);
  const a = agg(txSlice(from));
  console.log(`[microbench] ${name}: llmCalls=${a.llmCalls} hit=${a.hits}/${a.gets} (${a.hitRate}) tokens=${a.inputTokens}/${a.outputTokens}`);
  return { name, K, ...a };
}

async function main() {
  try { if (!(await fetch(`${BASE}/api/projects`, { signal: AbortSignal.timeout(2000) })).ok) throw 0; }
  catch { console.error('warm サーバが居ません。先に `node bin/setup.mjs`'); process.exit(1); }
  ensureDir(config.resultsDir);
  if (!existsSync(config.cacheDir)) console.warn('[microbench] ⚠ ANATOMIA_CACHE_DIR が無い — サーバが永続キャッシュで起動しているか確認');

  console.log(`[microbench] K=${K} verify/phase`);
  const noCache = await phase('noCache (毎回クリア)', true);
  const withCache = await phase('withCache (初回のみ蒸留)', false);

  const callsSaved = noCache.llmCalls - withCache.llmCalls;
  const tokSaved = (noCache.inputTokens + noCache.outputTokens) - (withCache.inputTokens + withCache.outputTokens);
  const redux = noCache.llmCalls ? +(callsSaved / noCache.llmCalls * 100).toFixed(1) : 0;
  const out = { K, noCache, withCache, callsSaved, tokensSaved: tokSaved, llmCallReductionPct: redux };
  writeFileSync(resolve(config.resultsDir, 'cache-microbench.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n[microbench] ① キャッシュによる蒸留 LLM 呼び出し削減: ${callsSaved}/${noCache.llmCalls} (${redux}%) · token 節約 ~${tokSaved}`);
  if (noCache.llmCalls === 0) console.log('[microbench] ⚠ llmCalls=0: providers(ANTHROPIC_API_KEY) 未設定か、Concordia でドメイン未検出の可能性');
  console.log('[microbench] →', resolve(config.resultsDir, 'cache-microbench.json'));
}

main().catch((e) => { console.error('[microbench] FAILED:', e.message); process.exit(1); });
