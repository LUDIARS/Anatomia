/**
 * src/cache/resolve.ts — pick the base content-addressed store from the env.
 *
 * Precedence: Redis (org-shared) > File (per-machine persistent) > memory (hermetic).
 *   ANATOMIA_CACHE_REDIS      redis:// URL  -> shared remote store
 *   ANATOMIA_CACHE_DIR        directory     -> persistent file store
 *   (neither)                               -> in-memory (default)
 * ANATOMIA_CACHE_REDIS_TTL (seconds) optionally bounds Redis retention.
 *
 * Both the MCP server and the web server resolve their card cache through here
 * so the backend choice is configured in one place. Instrumentation (hit/miss
 * recording) wraps whatever this returns — see instrumented.ts.
 *
 * SRP: env -> store selection only.
 */
import type { CacheStore } from "./store.js";
import { createMemoryStore } from "./store.js";
import { createFileStore } from "./file-store.js";
import { createRedisStore } from "./redis-store.js";

function redisTtl(): number | undefined {
  const t = Number(process.env["ANATOMIA_CACHE_REDIS_TTL"]);
  return Number.isFinite(t) && t > 0 ? t : undefined;
}

/** Resolve the base cache store from env (Redis > File > memory). */
export function resolveCacheStore<V>(): CacheStore<V> {
  const redis = process.env["ANATOMIA_CACHE_REDIS"];
  if (redis && redis.trim()) return createRedisStore<V>({ url: redis.trim(), ttlSeconds: redisTtl() });
  const dir = process.env["ANATOMIA_CACHE_DIR"];
  if (dir && dir.trim()) return createFileStore<V>(dir.trim());
  return createMemoryStore<V>();
}

/** One-line description of the resolved backend (diagnostics). */
export function describeCacheBackend(): string {
  if (process.env["ANATOMIA_CACHE_REDIS"]?.trim()) return `redis(${process.env["ANATOMIA_CACHE_REDIS"]})`;
  if (process.env["ANATOMIA_CACHE_DIR"]?.trim()) return `file(${process.env["ANATOMIA_CACHE_DIR"]})`;
  return "memory";
}
