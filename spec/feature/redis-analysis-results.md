---
id: AN-REDIS-RESULTS
title: Redis analysis result cache
type: feature
---

# Redis analysis result cache

Task: actio:4335aa2f-9a2d-4d11-a027-7a7f52bb5520. neco authorized implementation, measurement and actual-use verification.

UX-AN-W3: Cc consumers reuse identical returned analysis JSON across processes and restarts. Losing this property causes repeated analysis and waiting. This is not the LLM cache or serialization of live AST objects.

The supporting `delivery-surface` domain owns artifact identity, envelopes and diagnostics in `src/project/cache.ts`, and HTTP exposure in `src/adapters/web/routes/cache.ts`. The supporting `deterministic-cache` domain owns the Redis transport in `src/cache/redis-text-store.ts`. Source and adjacent tests are covered by their existing membership. These support the core supply/verify pipeline without changing its rules.

Only `ANATOMIA_RESULT_CACHE_REDIS` enables Redis for derived artifacts. No URL means existing disk behavior. Keys include resolved cache-home identity, project ID, exact artifact name, fingerprint and analyzer artifact schema. TTL bounds obsolete versions. Redis is checked before disk; valid disk hits populate Redis. Writes persist disk and Redis. Runtime Redis failure warns without credentials and falls back to disk, with error counters; invalid configuration fails early. Diagnostics distinguish configured, hits, misses, writes and errors: configuration alone is not proof of use. Redis transport bounds connection/command waits and does not keep idle CLI processes alive.

Freshness still requires the existing fingerprint walk. No TTL-only freshness, shared mutable AST, global flush, automatic Redis startup, or cross-home cache sharing. Output contracts and partial scopes are unchanged. Existing in-flight request coalescing remains authoritative within a process.

Acceptance: hermetic tests for identity/freshness, disk promotion, Redis failures and diagnostics; identical result payloads; real Redis write and fresh-process hit with no analysis/build; compare disk and Redis timings separately from fingerprint and analysis. Report regressions as well as improvements. Disable the variable and restart to recover disk-only behavior; no migration is required.

Validation evidence and outstanding live checks: [redis-results-validation.md](../test/redis-results-validation.md).
