/**
 * Compare identical returned JSON through disk and Redis; verify a fresh process hit.
 * @spec Redis analysis result cache
 * Usage: ANATOMIA_RESULT_CACHE_REDIS=<configured URL> node scripts/measure-result-cache.mjs <payload.json>
 * --disk-only records only the baseline when a Redis service is unavailable.
 */
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { AnalysisCache } from '../dist/project/cache.js';
import { resolveResultRedis } from '../dist/cache/redis-text-store.js';

const [, , input, mode, childHome] = process.argv;
if (!input) throw new Error('Provide a UTF-8 JSON analysis response file');
const payload = JSON.parse((await readFile(input, 'utf8')).replace(/^\uFEFF/, ''));
const diskOnly = mode === '--disk-only';
const redis = diskOnly ? undefined : resolveResultRedis();
if (!diskOnly && !redis) throw new Error('ANATOMIA_RESULT_CACHE_REDIS is required; no simulated Redis measurement');
const home = childHome ?? await mkdtemp(join(tmpdir(), 'anatomia-result-measure-'));
// Explicit no-env disk instance even when the parent has enabled Redis.
const diskEnv = process.env.ANATOMIA_RESULT_CACHE_REDIS;
delete process.env.ANATOMIA_RESULT_CACHE_REDIS;
const disk = new AnalysisCache(home);
if (diskEnv !== undefined) process.env.ANATOMIA_RESULT_CACHE_REDIS = diskEnv;
const shared = diskOnly ? disk : new AnalysisCache(home, undefined, redis);
const args = ['benchmark', 'review', 'immutable-payload'];
if (mode === '--child') {
  assert.deepEqual(await shared.readArtifact(...args), payload);
  assert.equal(shared.resultCacheStatus().redis.hits, 1);
  console.log(JSON.stringify({ freshProcessRedisHit: true, status: shared.resultCacheStatus() }));
} else {
  const start = performance.now(); await shared.writeArtifact(...args, payload);
  const writeMs = performance.now() - start;
  if (!diskOnly) assert.equal(shared.resultCacheStatus().redis.writes, 1, 'Redis write failed');
  const samples = { disk: [], redis: [] };
  for (let i = 0; i < 32; i++) {
    // Alternate order; 2 warmup pairs precede the measured pairs.
    for (const name of i % 2 ? ['redis', 'disk'] : ['disk', 'redis']) {
      if (diskOnly && name === 'redis') continue;
      const cache = name === 'disk' ? disk : shared;
      const before = performance.now(); const result = await cache.readArtifact(...args); const ms = performance.now() - before;
      assert.deepEqual(result, payload);
      if (i >= 2) samples[name].push(ms);
    }
  }
  const distribution = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return values.length ? { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], samples: values } : null;
  };
  const child = diskOnly ? null : JSON.parse(execFileSync(process.execPath,
    [fileURLToPath(import.meta.url), input, '--child', home], { encoding: 'utf8', timeout: 15000 }));
  const report = { payloadBytes: Buffer.byteLength(JSON.stringify(payload)), writeMs,
    disk: distribution(samples.disk), redis: distribution(samples.redis), observed: shared.resultCacheStatus(), child,
    limits: 'Warm cache reads including JSON decode, excluding fingerprint, analysis, HTTP and process startup. No cache flush. Isolated benchmark keys expire by TTL; temporary disk files are retained as evidence.' };
  await writeFile(join(home, 'measurement.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
