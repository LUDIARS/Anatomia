# Knowledge Migration Boundary Regressions

- Date: 2026-08-06
- Status: fixed in working tree
- Area: knowledge migration HTTP/application boundary
- Severity: high; forged requests could write attacker-selected files and canonical operations

## Summary

PR #243 introduced a regression in the legacy migration apply path: the HTTP client supplied the complete migration plan, including filesystem paths and canonical operations. The same surface returned local absolute paths in dry-run results, and unknown projects regressed from HTTP 404 to 400. T69 documentation also described label-only scenarios and synthetic metric inputs as executable integration evidence.

## Evidence

- `src/adapters/web/routes/domain-organization.ts` accepted `plan` from the JSON apply body.
- `src/knowledge/migration/apply.ts` wrote `plan.annotationWrites` and committed `plan.transactionDraft` after checking only project-independent fingerprint/head fields.
- `src/knowledge/migration/inventory.ts` and `plan.ts` published absolute source and annotation paths, including `migrationSources` persisted in the knowledge log.
- `errorStatus()` mapped `ProjectManager: unknown project` to 400.
- `src/knowledge/quality/quality.test.ts` passed hard-coded counts, hashes, and bytes to the metric calculator without executing the named scenarios.

## Regression Context

The previous domain-organization adapter explicitly mapped unknown projects to 404 and constrained Gate C writes below the configured knowledge root. Moving orchestration into the shared application service lost those boundary properties for the new migration route.

## Cause

The dry-run plan was treated as a trusted apply command instead of an untrusted review artifact. Persistence paths were modeled as absolute implementation paths, and T69 scenario metadata was mistaken for executable fixture coverage.

## Fix Requirements

- Regenerate the canonical migration plan server-side immediately before apply; accept only confirmation plus the reviewed source fingerprint and knowledge head.
- Reject client-supplied plans, path escapes, and symbolic-link write targets/directories.
- Publish and persist only repository- or write-root-relative paths.
- Restore unknown-project HTTP 404 responses.
- Keep T69 planned until registered tests execute the real parser/application/migration scenarios and derive measured baselines.

## Verification

Registered regression tests now cover forged plan rejection, server-side plan regeneration, relative-path output, canonical apply, retained source artifacts, malformed legacy JSON, stale scene manifests, and unknown-project status codes. Repository code and tests were not run during this review because Revisor owns execution and CI.

## Follow-up

Implement the seven executable T69 scenarios before marking the knowledge quality report or overall contract implemented.
