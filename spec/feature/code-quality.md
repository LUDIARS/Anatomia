---
id: AN-CODE-QUALITY
title: Explainable code scores and refactoring opportunities
type: feature
status: draft
---

# Code quality from analysis

UX-AN-W1/W4: reviewers can locate a domain boundary worth inspecting, with source evidence, before changing code. UX-AN-W3: simultaneous Cc requests reuse identical analysis and derived artifacts. Losing these properties means repeated waiting or speculative refactoring without traceable evidence.

`supply-verify` owns deterministic scoring and advisory candidates in `src/review/` and graph metrics in `src/supply/`. `delivery-surface` owns request lifetime in `src/project/` and presentation in the existing review CLI/HTTP adapter. Their existing membership patterns cover source and adjacent `__tests__`. No new domain or persistent business state is introduced.

Implementation ownership: `src/review/quality-scores.ts` calculates descriptive ratios, `src/review/refactoring-opportunities.ts` constructs bounded advisory findings, and `src/project/pending-work.ts` owns the shared promise lifetime. Each module explicitly references this heading so its functions resolve to the same specification without heuristic name matching.

## Contract and invariants

- `review --json` and `GET /api/projects/:id/review` return `quality` with schema version 1, separate 0..100 scores, raw numerators/denominators, formula identifiers, and bounded refactoring candidates. CLI text renders the same assessment.
- `pr-review` also exposes the whole-population assessment as `quality.assessment`, while retaining legacy complexity and changed-function fields. A partial analysis exposes its scope; its scores must not be presented as whole-repository measurements. Applying a review baseline does not change these whole-population descriptive scores.
- Scores are descriptive heuristics, not a measured AI success probability or a standard Maintainability Index. There is no aggregate score. Function/method graph nodes, including tests, form the population. Call-out-degree is explicitly a graph proxy, not AST cyclomatic or cognitive complexity. Unresolved calls and unmeasured control flow/shared-state semantics remain limitations.
- Dependency simplicity uses `100 / (1 + mean calls-out-degree / 4)`. Coverage is assigned/functions; separation is 1 - overlapping/assigned; cohesion is sum(internal)/(sum(internal)+sum(boundary)). All ratios are multiplied by 100. Cohesion counts an edge per domain that it touches, matching domain review semantics. Empty denominators produce null, not 100. No domains means domain scores are unavailable.
- Refactoring candidates include low cohesion (<0.5 with observed edges), isolated membership, boundary drift, overlapping ownership, and missing ownership. Counts remain uncapped; examples and output are bounded. These are review prompts, never permission to move/delete code or merge domains. Shared infrastructure may legitimately have low cohesion or many callers.
- Request-scoped prepared metrics/domain review are reused, never process-cached against a mutable graph. Metric aggregation uses a single edge scan instead of per-node async degree queries, preserving existing edge-count and traversal semantics.
- Concurrent full analysis shares work only for identical project/fingerprint. Partial analysis remains isolated. Artifact requests share only identical project/name/fingerprint; callers must version names when output semantics change. Pending promises are released on success/failure; a failure can be retried. There is no TTL-based stale success.

## Validation and recovery

Hermetic tests cover empty/unknown input, score evidence, deterministic candidate ordering/capping, parallel-edge counts and constant graph-query count, concurrent same/different keys and failure retry. Register source/tests in cc.acceptance.json. Test execution is recorded separately according to human authorization; mandatory policy is not authorization.

Revert this change to recover prior review output and request handling. Derived review cache uses a versioned key, so old artifacts cannot silently omit the quality assessment. No migration or automatic refactoring is needed.

## Implementation verification (2026-10-03)

- `npm run typecheck` and `npm run build`: passed in the task worktree.
- `git diff --check`: passed.
- Human-authorized regression and timing verification is recorded in [code-quality-validation.md](../test/code-quality-validation.md): all 1639 unique tests have passing results after targeted environment recovery. The Anatomia graph metric comparison showed a 37.6% median reduction with identical outputs; this is not a whole-pipeline or AI success-rate measurement. Service deployment/reflection is not covered by this measurement.
- Investigation used Anatomia `context` and deterministic `plan --no-llm --no-map`, plus an existing reference project at UX revision 1. The plan identified existing supply-verify/domain-modeling/delivery-surface boundaries; only the first and third are changed here. No external judgment cards were applied.
