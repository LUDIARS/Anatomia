/**
 * A-3 — Persistent content-addressed file store (DESIGN §9 shared cache).
 *
 * Backs a CacheStore<V> with one JSON file per key under `dir`. Because keys are
 * content+version hashes (see versionedKey) and values are immutable, writes are
 * idempotent (same key → same value): concurrent writers from multiple sessions
 * cannot disagree, so no locking is needed. Writes are atomic (tmp file + rename)
 * so a crash mid-write never leaves a half-written entry that a reader could
 * parse. A corrupt / unreadable entry is treated as a miss (re-distilled), never
 * a crash.
 *
 * SRP: persistence only. Key construction + the in-memory store live in store.ts.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CacheStore } from "./store.js";

/**
 * A file-backed cache store rooted at `dir`. The directory is created lazily on
 * the first write. Keys must be filesystem-safe (sha256 hex from versionedKey).
 */
export function createFileStore<V>(dir: string): CacheStore<V> {
  let ensured = false;

  async function ensureDir(): Promise<void> {
    if (ensured) return;
    await mkdir(dir, { recursive: true });
    ensured = true;
  }

  function pathFor(key: string): string {
    return join(dir, `${key}.json`);
  }

  return {
    async get(key) {
      try {
        const raw = await readFile(pathFor(key), "utf8");
        return JSON.parse(raw) as V;
      } catch {
        // Missing file or unparseable content => cache miss (re-distil).
        return undefined;
      }
    },

    async set(key, value) {
      await ensureDir();
      const finalPath = pathFor(key);
      // Unique-enough tmp name: same key writers produce the same value, so a
      // clobber is harmless; the suffix just avoids a partial read of finalPath.
      const tmpPath = `${finalPath}.tmp-${process.pid}`;
      await writeFile(tmpPath, JSON.stringify(value), "utf8");
      await rename(tmpPath, finalPath);
    },
  };
}
