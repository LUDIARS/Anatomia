// 1 run の実行: reset → claude headless → metrics 収集。
import { resolve } from 'node:path';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { config } from '../config.mjs';
import { run, ensureDir, readJSONL, sum } from './util.mjs';
import { resetTo, captureDiff } from './workspace.mjs';
import { writeArmSettings, armEnv } from './settings.mjs';

/** claude --output-format json の配列から result イベントを取り出す。 */
function parseResult(stdout) {
  try {
    const arr = JSON.parse(stdout);
    if (Array.isArray(arr)) return arr.find((e) => e && e.type === 'result') || null;
  } catch { /* fallthrough */ }
  // 念のため行ごとにも探す
  for (const line of stdout.split(/\r?\n/)) {
    try { const e = JSON.parse(line); if (e && e.type === 'result') return e; } catch { /* skip */ }
  }
  return null;
}

function cacheLineCount() {
  if (!existsSync(config.cacheLog)) return 0;
  return readFileSync(config.cacheLog, 'utf8').split(/\r?\n/).filter((l) => l.trim()).length;
}

/** run を 1 本実行して metrics record を返す (採点は別フェーズ)。 */
export async function executeRun({ runId, arm, model, base }) {
  const dir = resolve(config.resultsDir, runId);
  ensureDir(dir);
  const hookLog = resolve(dir, 'hooks.jsonl');
  const settingsPath = writeArmSettings(arm);
  const promptText = readFileSync(config.taskFile, 'utf8');

  resetTo(config.workspace, base);
  const cacheBefore = cacheLineCount();

  const args = [
    '-p',
    '--model', model,
    '--settings', settingsPath,
    '--dangerously-skip-permissions',
    '--output-format', 'json',
  ];
  const env = armEnv(arm, { hookLog, cacheLog: config.cacheLog });
  const res = await run('claude', args, { input: promptText, timeoutMs: config.runTimeoutMs, cwd: config.workspace, env });

  // 成果物
  const diff = captureDiff(config.workspace, base);
  writeFileSync(resolve(dir, 'diff.patch'), diff, 'utf8');
  writeFileSync(resolve(dir, 'claude-stdout.json'), res.stdout, 'utf8');
  if (res.stderr) writeFileSync(resolve(dir, 'claude-stderr.txt'), res.stderr, 'utf8');

  const result = parseResult(res.stdout);
  const usage = result?.usage || {};
  const hooks = readJSONL(hookLog);

  // cache transcript の run 区間スライス
  const allCache = readJSONL(config.cacheLog);
  const cacheSlice = allCache.slice(cacheBefore);

  const record = {
    runId, arm, model,
    ok: res.code === 0 && !res.timedOut && !!result,
    timedOut: res.timedOut,
    wallMs: res.wallMs,
    diffLines: diff.split(/\r?\n/).length,
    diffEmpty: !diff.trim(),
    agent: result ? {
      durationMs: result.duration_ms, apiMs: result.duration_api_ms, numTurns: result.num_turns,
      costUsd: result.total_cost_usd,
      inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens, cacheCreationTokens: usage.cache_creation_input_tokens,
      result: typeof result.result === 'string' ? result.result.slice(0, 500) : null,
      isError: result.is_error,
    } : null,
    // ③ 速度: Anatomia フックの追加遅延
    anatomiaOverheadMs: sum(hooks, (h) => h.ms),
    hookInvocations: hooks.length,
    verifyFired: hooks.filter((h) => h.hook === 'verify' && h.fired).map((h) => ({ file: h.file, gates: h.gates })),
    supplyFired: hooks.filter((h) => h.hook === 'supply' && h.fired).length,
    // ① cache: run 区間の蒸留イベント
    cache: aggCache(cacheSlice),
  };
  writeFileSync(resolve(dir, 'record.json'), JSON.stringify(record, null, 2), 'utf8');
  return record;
}

function aggCache(events) {
  const gets = events.filter((e) => e.kind === 'get');
  const llm = events.filter((e) => e.kind === 'llm');
  const hits = gets.filter((e) => e.hit).length;
  return {
    gets: gets.length, hits, misses: gets.length - hits,
    hitRate: gets.length ? hits / gets.length : 0,
    llmCalls: llm.length,
    inputTokens: sum(llm, (e) => e.usage?.inputTokens),
    outputTokens: sum(llm, (e) => e.usage?.outputTokens),
  };
}
