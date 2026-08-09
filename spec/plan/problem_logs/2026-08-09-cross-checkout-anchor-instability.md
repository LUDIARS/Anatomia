# Anchors And Gate Findings Did Not Survive A Change Of Checkout

- Date: 2026-08-09
- Status: fixed (anchor identity); the findings that motivated it are closed as stale
- Area: dag/hash · supply gates · Revisor PR review
- Severity: review findings could not be re-examined after they were filed, and two gates measured the wrong set of functions

## Summary

Two findings from Anatomia PR #6 (Memoria #689, #690) could not be reproduced against
current `main`. Investigating why exposed two defects rather than two code-quality
problems.

`AnchorId` folded the **absolute** source path (`dag/hash.ts`). A Revisor review runs in
an ephemeral worktree, so every function in a review carries an anchor that exists only
inside that worktree — no anchor cited in a review can ever be resolved again from the
repository the review was about.

Separately, `buildVerdict` only derived a target path on its multi-file branch. For a
single-file diff every changed function was attributed to the literal string `"<diff>"`,
which no spec link, `by:path` rule or sibling sample can match, and which
`isTestFilePath` reports as production code.

## Evidence

- `anatomia find --symbol 71ff50804db16bca` and `anatomia callers` both return zero hits
  against `main` at `6ce3993`. The anchor named in Memoria #690 does not exist in the
  repository it was filed against.
- `dag/hash.ts` folded `fn.sourceRange.filePath` — the absolute path — into the anchor
  hash. Two checkouts of the same commit therefore produced two disjoint anchor spaces.
- `core.ts buildVerdict` left `targetPath` undefined for a single-file diff: the
  multi-file branch supplied one, the single-file path did not, and `extractFunctions`
  fell back to `"<diff>"`.
- With that fallback, verifying a diff that fully rewrote one function reported it as a
  spec orphan even though its file carried an `@spec` annotation that the linker had in
  fact resolved (`anatomia links list` showed the explicit link at confidence 1.0).
- `isTestFilePath("<diff>")` is false, so `productionChanged` did not exclude test
  functions: `coupling_delta` and `spec_linkage` were measuring test bodies, whose
  coupling is high by design.

## Regression Context

The orphan findings in #689 were not missing spec links; they were the `"<diff>"`
attribution making every fully-added function unmatchable. The `coupling_delta` finding
in #690 named an anchor that cannot be resolved today, and the gate that produced it was
at the time also measuring test bodies — the two defects above are sufficient to explain
both findings without any code-quality problem in the reviewed change.

## Resolution

- `buildVerdict` resolves the path from the diff's own `+++ b/<path>` header when the
  caller supplies none, which is the default the CLI already documented for `--file`.
  Verifying the same change now passes all five gates.
- `assignAnchorId` folds the **repo-relative** path, so a commit yields the same anchors
  in the repository and in any worktree of it. `filesContentKey` / `graphCacheKey` /
  `detectionCacheKey` take a repo root for the same reason.
- `branch/diff.ts` moved to the relative form in step; its before/after sides must hash
  the same path or unchanged functions are reported as changed.

## Waiver

Memoria #690's `coupling_delta` finding (anchor `71ff50804db16bca`, coupling 14 vs repo
p95 11) is closed as **stale, not accepted**: the anchor does not resolve against current
`main`, and the gate that produced it was measuring a function set that included test
bodies. No coupling exemption is being granted — a re-analysis of current `main` reports
no `coupling_delta` failure, and any future finding will be resolvable because anchors
are now checkout-stable.

## Follow-up

- A persistent per-file parse cache was attempted on top of the stable identity and
  measured only ~20% on a warm cache while costing ~1.5x on the first analysis and
  ~26MB per repository; it was not adopted. See `feat/ast-codec-file-cache`.
