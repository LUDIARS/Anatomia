/**
 * src/supply/cache.ts — content-addressed cache for assembled context bundles.
 *
 * buildContextBundle(ctx, req) (core.ts) is deterministic in (req, ctx): it
 * resolves a landing point and assembles the bundle from the analyzed context.
 * Repeated identical context/where requests on an unchanged project recompute
 * landing resolution + assembly every time; caching the finished ContextBundle
 * by (request + context identity) makes the repeat free.
 *
 * Correctness: the bundle reads ctx.files, ctx.specClauses, ctx.domains and
 * ctx.rules — and spec clauses can come from a SIBLING spec/ dir that is NOT in
 * ctx.files (collected separately in analyze Phase 5). So the context-identity
 * key MUST fold all of those, not just the file set, or a spec edit would serve
 * a stale bundle. The key is built in core.ts (which has the ctx); this module
 * owns the version, the store type, and the process-shared default.
 *
 * SRP: cache type + version + shared store only.
 */

import { type CacheStore } from "../cache/store.js";
import { resolveCacheStore } from "../cache/resolve.js";
import type { ContextBundle } from "../types.js";

/** BUMP when ContextBundle's shape or assembly semantics change. */
export const BUNDLE_CACHE_VERSION = "1";

/** Content-addressed store for assembled context bundles. */
export type BundleCache = CacheStore<ContextBundle>;

/**
 * Process-shared bundle cache (Redis > File > Memory, per ANATOMIA_CACHE_*).
 * Resolved once so every context request in a warm server reuses the store.
 */
let shared: BundleCache | undefined;
export function sharedBundleCache(): BundleCache {
  return (shared ??= resolveCacheStore<ContextBundle>());
}
