# Stale AIFormat submodule link

- Date: 2026-08-23
- Status: fixed in working tree
- Area: dependency provenance (`lib/aiformat` submodule)
- Severity: medium; Anatomia reads outdated shared rules and review criteria

## Summary

Anatomia still records an old AIFormat submodule commit. This is a maintenance regression because the shared rules have advanced while Anatomia's pinned provenance has not.

## Evidence

- Anatomia `main` records `lib/aiformat` at `90f2f1e7efe127b8c24c34a3c61e66a1c3023bce`.
- AIFormat `origin/main` is `fbc7c9776a28f8ff6a537a6969aea8e11457e3ac` as of 2026-08-23.
- `.gitmodules` already points to `https://github.com/LUDIARS/AIFormat.git`; the stale value is the gitlink commit, not the repository URL.

## Regression Context

The submodule was introduced previously, but its pinned commit was not kept current with the shared AIFormat rules.

## Cause

The Anatomia gitlink was not advanced when AIFormat `main` changed.

## Fix Requirements

- Advance `lib/aiformat` to the current AIFormat `origin/main` commit.
- Do not modify or discard the dirty shared-checkout submodule working tree.

## Verification

- Confirm the recorded gitlink is `fbc7c9776a28f8ff6a537a6969aea8e11457e3ac`.
- Confirm that commit is the current local `origin/main` for AIFormat.
- No unit, integration, or startup tests are run unless explicitly requested.

## Follow-up

Revisor should validate that the referenced AIFormat commit is reachable when reviewing the local PR.
