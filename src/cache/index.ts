/**
 * cache/ — Shared content-addressed LLM cache (A-3, DESIGN §4.4 / §9).
 *
 *   store.ts      — CacheStore<V> interface, in-memory impl, versionedKey
 *   file-store.ts — persistent one-file-per-key store (cross-process sharing)
 */
export type { CacheStore } from "./store.js";
export { createMemoryStore, versionedKey } from "./store.js";
export { createFileStore } from "./file-store.js";
