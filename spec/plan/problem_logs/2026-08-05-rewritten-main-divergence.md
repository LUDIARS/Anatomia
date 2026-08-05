# Rewritten GitHub Main Diverged From Local Source

- Date: 2026-08-05
- Status: investigating
- Area: repository history / Revisor publication
- Severity: release publication blocked; privacy-redacted history can be reintroduced by an incorrect merge

## Summary

Anatomia's local `main` and GitHub `main` have no common ancestor. Revisor local PR #219 passed review, but publication stopped because the GitHub base is not contained in the local source of truth.

The divergence followed a remote history rewrite that replaced a private project identifier with the neutral placeholder `PrivateGame`. Local development continued on the pre-rewrite history. A normal unrelated-history merge would make the removed history reachable from GitHub again and must not be used.

## Evidence

- The `origin/main` reflog records a forced update at 2026-07-28 08:51:01 +09:00 from `8336240` to `bbe993b`.
- `8336240` and `bbe993b` have the same author date, commit date, and subject, but different trees.
- The rewritten remote tree at `c179735` and its local work-equivalent tree at `c5ce12b` differ only in 17 files / 19 substitutions associated with the private-name replacement.
- Patch comparison finds 115 exact equivalent non-merge patches between the histories. The remaining remote patches are rewrite-affected counterparts; the current local line additionally has nine later commits.
- `c5ce12b` is an ancestor of local `main` (`ba083dd`). Local development added nine commits from 2026-07-30 through 2026-08-04.
- The current GitHub tree contains zero occurrences of the removed identifier and 11 occurrences of `PrivateGame`. The current local tree still contains nine occurrences of the removed identifier across eight files.
- Revisor #219 reported `GitHub 'main' is not contained in the local source of truth.` on 2026-08-05.

## Regression Context

The remote rewrite correctly removed the private identifier from published history, but the local source-of-truth branch was not moved to the rewritten lineage. Subsequent reviewed work accumulated on the old lineage. Revisor's no-force-push containment gate correctly prevented publishing that lineage.

## Cause

The leading cause is an incomplete post-rewrite local migration: GitHub `main` was force-rewritten for privacy, while local `main` remained on the original object graph and accepted later commits.

## Fix Requirements

- Do not force-push and do not connect the unrelated histories with an `ours` merge.
- Reconstruct the authoritative local base from rewritten `origin/main`.
- Replay only the nine post-equivalent local commits after `c5ce12b`, preserving all privacy substitutions.
- Confirm that the removed identifier is absent from the reconstructed tree and from every newly published commit.
- Close or supersede stale Revisor #219/#220 state, remove any local-only prepared release tag after confirming it was not published, and resubmit the changes against the reconstructed base.
- Rebase the dependent #680/#681 branches onto the reconstructed and reviewed base before submission.

## Verification

No runtime or unit tests were run during this investigation.

Required repository checks:

- rewritten GitHub `main` is an ancestor of reconstructed local `main`;
- tree comparison at the rewrite boundary differs only by the documented privacy substitutions;
- no removed identifier exists in the reconstructed tree or outgoing commit range;
- the nine later local commits remain represented by content after replay;
- Revisor publication preflight accepts the reconstructed ancestry.

## Follow-up

Document the one-time history migration decision before changing local `main`. Preserve the current branches and prepared review state until the reconstructed line is verified, so no reviewed work is lost.
