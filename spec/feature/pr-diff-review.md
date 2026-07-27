# Ephemeral PR diff review

`anatomia pr-review --repo <worktree> --base <ref> --json` analyzes one branch
relative to its merge-base. It calls `analyze()` directly and never uses
ProjectManager, the project registry, or a persistent CacheStore. The result is
temporary CI evidence rather than a saved project snapshot.

The JSON report combines:

- function-level branch diff;
- changed-anchor to target-domain membership;
- five-gate verification over the unified diff;
- architecture violations, cycles, structural duplication and cross-domain
  coupling;
- changed domain overlap, isolation and boundary drift;
- changed orphan functions and spec gaps;
- a deterministic 0..100 complexity score.

The score is `100 / (1 + (averageCyclomatic - 1) / 4)`, rounded and clamped to
0..100. A caller compares the PR worktree's score with an independently
analyzed merge-base worktree, so the threshold remains workflow policy rather
than an Anatomia persistence concern.
