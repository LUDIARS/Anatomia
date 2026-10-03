# Code quality and request reuse validation

- Date: 2026-10-03 JST
- Implementation under test: a66f95e
- Baseline implementation: 190db8867eb6890eefa983eaee8e389c25dedfc4
- Runtime: Node.js v24.14.1, Windows, Vitest 4.1.9
- Regression and performance verification was explicitly authorized.

## Regression results

`npm test -- --reporter=dot`: 248/251 files and 1636/1639 tests passed in 179.13 seconds. The new quality, HTTP contract, metric aggregation, and manager concurrency tests passed.

Three pre-existing test files failed for environment/setup reasons:

- `src/spec-review/review.test.ts`: the task worktree had not initialized its pinned AIFormat submodule, so `FORMAT_SPEC.md` was unavailable.
- `src/fs/__tests__/git-ignore.test.ts`: a real Git operation exceeded its timeout; cleanup also reported EBUSY.
- `src/map/__tests__/project-roots.test.ts`: real Git worktree setup exceeded its timeout.

Initialized `lib/aiformat` at the pinned fbc7c9776a28f8ff6a537a6969aea8e11457e3ac using the local existing repository, without changing the submodule revision or disabling hooks. Re-ran only those three files in the normal execution environment with `--maxWorkers=2 --reporter=verbose`: all 25 tests passed in 43.54 seconds. Thus all 1639 unique tests have a passing result across the initial run and targeted retry; this is not a claim that the first full-suite invocation passed. No production code or tests were changed to suppress the environment failures.

`npm run typecheck`, `npm run build`, and `git diff --check` also passed before runtime verification.

The subsequent `verify --repo <task-worktree> --diff <baseline-to-current.diff> --json` initially reported four spec-linkage orphans. Corrected the three new module headers to reference the actual `Code quality from analysis` heading (the linker interprets `@spec` as heading text, not a YAML ID). These are annotation-only changes. Rebuilt and repeated verify: all five gates passed (rule conformance, duplication, spec linkage, coupling delta, convention drift). No executable behavior changed after the regression run.

`where --project anatomia` also returned existing landing candidates including supply-verify and delivery-surface, using the catalog's home through `ANATOMIA_HOME`. The initial `--home` invocation did not reach that registry; the corrected call succeeded. Its sandbox run warned about Git-ignore fallback, so these landing hints were not used as measured coverage evidence. The earlier deterministic `plan` and direct source/domain declarations determined ownership.

## Metrics comparison

Compared the baseline `computeMetrics` (transpiled from the exact Git revision) with the built new implementation, on the same in-memory graph object and domain membership. Deep equality was asserted for every returned metric before measuring. Two warmup pairs precede nine measured pairs; old/new execution order alternates. Reported values are medians, in milliseconds. Parsing, fingerprinting, HTTP, and review assembly are outside the timed section.

| Graph | Nodes | Edges | Previous ms | New ms | Median reduction |
|---|---:|---:|---:|---:|---:|
| Synthetic, degree 4 | 2,000 | 8,000 | 20.4527 | 16.6157 | 18.8% |
| Synthetic, degree 12 | 10,000 | 120,000 | 210.2447 | 188.8804 | 10.2% |
| Synthetic, degree 12 | 50,000 | 600,000 | 1059.5826 | 1026.4699 | 3.1% |
| Anatomia source graph | 4,754 | 9,035 | 94.6371 | 59.0381 | 37.6% |

Synthetic graphs use padded node IDs; node n connects to `(n + 17 * offset) % size` for offsets 1..degree. Each consecutive 100 nodes belongs to one domain. Every fifth offset is a reads edge; otherwise every seventh is writes; remaining edges are calls. Cycles and cross-domain edges are included. Source range values are fixed and all nodes are functions.

The Anatomia graph was built from the checked-out repository in the normal execution environment, with successful Git ignore discovery. A preliminary sandbox measurement hit the existing Git-ignore fallback and was superseded by this run. The host was not isolated from unrelated workloads; these timings are observations, not an SLA or a guarantee for the full analysis pipeline. The 3.1% large-graph delta is small relative to sample variation.

Anatomia graph raw old samples: 119.4345, 94.6371, 94.8696, 78.6519, 93.0240, 81.4280, 73.2550, 109.4695, 145.9731 ms.

Anatomia graph raw new samples: 70.9960, 100.5247, 59.0381, 47.8236, 58.0297, 61.1583, 49.2690, 50.7941, 68.0617 ms.

The graph-query interface call count changes from `1 + 5 * nodeCount` to 2 (`allNodes` and `edgesMatching`). For the Anatomia sample that is 23,771 to 2. This counts interface invocations, not storage engine queries or network round trips.

## Concurrent Cc request behavior

The hermetic manager tests cover concurrent calls for two identical artifacts, a different artifact, and a direct context. They assert one analysis, one build per artifact identity, and shared results; additional cases verify retry after analysis/artifact failure, independent fingerprints, and partial-result isolation. No end-to-end Cc HTTP latency improvement is claimed.

The existing Anatomia `test-suggestions` endpoint returned HTTP 200 and recommended measuring the bottleneck and retaining an external performance guardrail. Measurements and deterministic graph-query count assertions implement that advice; a wall-clock CI budget has not been agreed and is not invented here.

## Boundaries and recovery

Core `supply-verify` owns scoring/evidence (UX-AN-W1/W4); generic `delivery-surface` owns request lifetime (UX-AN-W3). Specification: `spec/feature/code-quality.md`. Shared pending work is released on success/failure; unknown data never receives a perfect score. Existing CLI/HTTP review and PR-review transport the assessment. Revert the implementation to recover prior behavior; the versioned derived cache key requires no migration.

Services were not deployed or restarted as part of this validation. Review/merge and deployed reflection remain separate workflow steps.

## PR 2314 conflict recovery (2026-10-03)

The previously reported main-checkout index lock was absent when recovery was authorized; this session did not delete or move it. The subsequent Cc merge request detected conflicts against Revisor main `1fe8b18d3ae1b7bfed9b6a2974a204d981df7684`. Integration in the task worktree retains both features' acceptance registrations and delivery-surface spec references. Generated link-stability state follows main; no application behavior was edited for conflict resolution.

After initializing the pinned Lapilli dependency, typecheck and build passed. The first regression attempt accidentally traversed a renamed dependency junction and collected third-party package tests (125 collection failures); it is not a passing project regression result. Moving that junction beneath an excluded `node_modules` path corrected the environment without changing shared dependencies or test configuration. The normal full suite then passed: 252 files, 1641 tests, 222.14 seconds (`npm test -- --maxWorkers=4 --reporter=dot`). Service reflection and user-experience verification remain unperformed.
