---
id: AN-REDIS-RESULTS-VALIDATION
type: test
---

# Redis analysis result validation

Task: actio:4335aa2f-9a2d-4d11-a027-7a7f52bb5520. Base: `8a7e378f378c14894e92790b081760305d2a3a0d`.

## Completed (2026-10-03)

- Typecheck and build passed.
- Full regression: 255 files / 1649 tests passed, 121.00 seconds, `npm test -- --maxWorkers=4 --reporter=dot`.
- `verify --repo <task-worktree> --diff <staged-diff> --json`: all five gates passed.
- Hermetic tests cover fresh-cache-instance Redis reads without disk access, fingerprint/project/home/name separation, legacy envelope rejection, disk promotion, failures with secret-free warning, TTL, bounded timeout, reconnect, late connection disposal, process reference release and the diagnostics route.
- No source change to the existing LLM Redis adapter or its activation settings.

## Review regression recovery

PR #2353 initially failed in the existing linked-worktree normalization test at its unchanged 60-second timeout. All Redis tests passed. The review run had 254 passing files / 1648 passing tests; several unrelated Git subprocess tests also slowed substantially. Resource contention from unrestricted default workers is the leading hypothesis, not a demonstrated Redis regression. The previous successful local full suite explicitly used four workers. `vitest.config.ts` now makes that same concurrency limit the default for local and review runs; assertions, test selection and timeout remain unchanged.

Recovery validation on 2026-10-03: `npm test -- --reporter=dot` passed all 255 files / 1649 tests in 201.18 seconds with the configured default worker limit. Typecheck, build and all five static verification gates passed. This supports the configuration change but is not a speedup measurement or proof of the precise timeout cause. Revisor re-review is still required. Roll back only the `maxWorkers` setting to restore previous scheduling; no runtime service setting changes with this fix.

## Baseline measurements

Input: the previously verified live Anatomia `review --json` response, 48,935 UTF-8 bytes. `scripts/measure-result-cache.mjs <payload.json> --disk-only` performs two warmups then 30 reads, with equality checks outside timing. Disk median: 3.2233 ms; p95: 5.6281 ms. Includes disk read and JSON parsing, excludes fingerprint, analysis, HTTP and process startup. The host was not isolated, and regression tests were also running; this is an observation, not an SLA.

The existing `ProjectManager.fingerprint('anatomia')` was measured separately against the registered main checkout: first call 705.7114 ms; following calls 212.6165, 227.5871, 217.0897, 410.1005, 230.2138 ms (median 227.5871 ms). Redis does not remove this work. These component observations must not be added together as a measured end-to-end result.

## Pending live Redis verification

The Redis endpoint referenced by the current Concordia catalog, `127.0.0.1:6379`, refused a connection. Excubitor's service inventory contained no Redis service. A usable connection/configuration has been requested from neco; no service was installed or started and the deployed Anatomia configuration was not changed.

Redis speedup, live Redis use, restart reuse and deployed HTTP diagnostics are **unverified**. Fake-client unit tests are not evidence of live Redis use. Run the measurement script without `--disk-only` after configuring `ANATOMIA_RESULT_CACHE_REDIS`; it requires a successful Redis write and a separate process's Redis hit and fails instead of reporting a disk fallback as success. The script uses isolated keys with TTL and never flushes Redis. Then enable only the result-cache setting in the approved service configuration, verify `/api/analysis-cache` counters increase while serving the actual review endpoint, and record both cold/warm latency and returned-payload equality.

Recovery: disable `ANATOMIA_RESULT_CACHE_REDIS` and restart through Excubitor. Disk remains populated; existing analysis/context memory caching is unchanged. Domains: supporting `delivery-surface` (artifact contract/diagnostics), supporting `deterministic-cache` (transport). Value: UX-AN-W3. Specification: `spec/feature/redis-analysis-results.md`.
