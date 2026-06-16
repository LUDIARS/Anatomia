/**
 * src/cache/redis-store.ts — Redis-backed CacheStore (A-3 shared remote backend, D-2).
 *
 * The A-3 distillation cache is content-addressed + immutable, so it shares
 * cleanly across machines. A per-machine FileStore only warms one box; a Redis
 * store lets a whole org share one warm cache → the hit-rate climbs (a card any
 * machine distilled is served to all), and Redis's own `maxmemory` + LFU gives
 * eviction for free (no custom policy needed).
 *
 * Optionality: `redis` is an optionalDependency, imported via a *computed*
 * specifier so tsc never requires it to be installed and a missing/unreachable
 * Redis degrades gracefully (get → miss, set → no-op) rather than crashing the
 * analysis — same contract as a corrupt FileStore entry.
 *
 * Keys are namespaced with a prefix. No TTL by default (content-addressed values
 * are valid until the model/prompt version bumps, which changes the key);
 * `ANATOMIA_CACHE_REDIS_TTL` can add one if an operator wants bounded retention.
 *
 * SRP: Redis adaptation of CacheStore only. Key construction lives in store.ts.
 */
import type { CacheStore } from "./store.js";

/** Minimal Redis client surface (node-redis v4 compatible). Injectable for tests. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { EX?: number }): Promise<unknown>;
}

export interface RedisStoreOptions {
  /** redis:// URL (node-redis). Ignored when `client` is supplied. */
  url?: string;
  /** Pre-built client (tests / custom wiring). Bypasses the lazy connect. */
  client?: RedisLike;
  /** Key namespace prefix. Default "anatomia:". */
  prefix?: string;
  /** Optional TTL (seconds). Omit for no expiry. */
  ttlSeconds?: number;
}

// Computed specifier so tsc does not statically resolve (and thus require) the
// `redis` module at build time. Resolved at runtime from node_modules if present.
const REDIS_MODULE = "redis";

export function createRedisStore<V>(opts: RedisStoreOptions = {}): CacheStore<V> {
  const prefix = opts.prefix ?? "anatomia:";
  const k = (key: string) => prefix + key;
  let clientPromise: Promise<RedisLike | null> | null = null;
  let warned = false;

  async function getClient(): Promise<RedisLike | null> {
    if (opts.client) return opts.client;
    if (!clientPromise) {
      clientPromise = (async () => {
        try {
          const mod = (await import(REDIS_MODULE)) as {
            createClient: (o?: { url?: string }) => RedisLike & {
              on(event: string, cb: (...a: unknown[]) => void): unknown;
              connect(): Promise<unknown>;
            };
          };
          const client = mod.createClient(opts.url ? { url: opts.url } : {});
          client.on("error", () => { /* swallow; degrade to miss */ });
          await client.connect();
          return client;
        } catch (e) {
          if (!warned) {
            warned = true;
            console.error(`[anatomia/cache] redis unavailable, degrading to no-op: ${(e as Error).message}`);
          }
          return null;
        }
      })();
    }
    return clientPromise;
  }

  return {
    async get(key) {
      try {
        const c = await getClient();
        if (!c) return undefined;
        const raw = await c.get(k(key));
        if (raw == null) return undefined;
        return JSON.parse(raw) as V;
      } catch {
        return undefined; // unreachable redis / bad json => cache miss
      }
    },
    async set(key, value) {
      try {
        const c = await getClient();
        if (!c) return;
        const json = JSON.stringify(value);
        if (opts.ttlSeconds && opts.ttlSeconds > 0) await c.set(k(key), json, { EX: opts.ttlSeconds });
        else await c.set(k(key), json);
      } catch {
        /* ignore — the cache must never break analysis */
      }
    },
  };
}
