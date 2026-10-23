# Test failures on main and on Revisor hosts (git hooks / 8.3 TEMP)

- Date: 2026-10-23
- Status: fixed in branch `fix/main-test-failures-short-temp`
- Area: `src/map/project-roots.ts`, `src/knowledge/migration/apply.ts`, their tests
- Severity: medium; the full suite never passed on main from a Concordia session, and Revisor review hosts reported 3 more failures
- Origin: Actio task 3af9e047-252a-4d44-b215-e4554462deaa (bug report), fix task 9ead4900-b6b1-47d8-9c2f-34e4e7ec7b2b

## Summary

1. `project-roots.test.ts > folds a linked worktree into the main checkout` timed out (60 s) on main.
2. With TEMP spelled as an 8.3 short alias, the migration apply tests (2) and the domain-organization migration route test (1) failed with
   `legacy migration refuses symbolic link directory` / HTTP 400; the worktree fold test also failed its assertion.

## Cause

1. The test's throw-away git repo inherited the session's `core.hooksPath` (injected through `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0`). The hooks ran on `commit` (~47 s) and `worktree add` (~53 s), so the test always exceeded its timeout. The implementation was correct.
2. `os.tmpdir()` returns the short spelling while `realpath` and `git rev-parse` return the long one.
   - `prepareWriteTargets` compared `realpath(dir)` with `resolve(dir)`, so a plain directory under a short-alias root looked like a link.
   - `probeProjectRoot` took the registered path as-is; it never sat inside the worktree git reported, so the identity key of the linked worktree and the main checkout differed.

## Fix

- `vitest.setup.ts` (registered in `vitest.config.ts#setupFiles`) drops the injected `GIT_CONFIG_*` entries and sets `core.hooksPath` to a directory that never exists, for every git the suite spawns. The same hook delay also timed out `branch/__tests__/diff.test.ts` and `fs/__tests__/git-ignore.test.ts` intermittently; `branch/__tests__/hermetic-git.test.ts` pins the setup.
- `probeProjectRoot` realpaths a live root before asking git and building the identity key.
- `prepareWriteTargets` compares `realpath(dir)` with `realpath(writeRoot)` + the target's path inside the write root; targets outside the write root are refused. Links inside the write root are still refused.
- `src/fs/__tests__/short-temp.ts` (`withShortTemp`) reproduces a short TEMP locally; regression tests use it for the migration apply and the worktree fold.

## Recovery

Revert the squash commit. No data format or persisted state changed.
