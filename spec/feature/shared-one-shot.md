# Shared subscription CLI boundary

- Value: UX-AN-W1, UX-AN-W3. Card generation must use the intended model and record its actual identity.
- Domain: deterministic-cache (supporting); delivery-surface selects job-specific models.
- Owner: Lapilli owns default model roles, CLI executable resolution and child subscription environment.
  Anatomia owns prompts, response validation, usage records and deadlines.
- Invariants: explicit model pins remain exact; CLI errors never become stub success;
  model identity reported for cache/cost records matches the model sent to the CLI.
- Restore: revert the consumer commit and its Lapilli dependency pin together.
- Validation: source inspection and diff whitespace checks passed. Typecheck/build were attempted;
  both report existing Kuzu dependency type-resolution errors in graph/kuzu.ts and
  knowledge/kuzu-projection.ts after an offline install with dependency scripts disabled.
  No changed-source diagnostics were reported. Live CLI calls and tests were not run.
- Fresh checkout setup: run `git submodule update --init -- lib/lapilli` before dependency
  installation. Revisor's `lapilli-submodules` setup case obtains the pinned gitlink from
  the local Lapilli repository; existing submodules/install/test/typecheck cases remain.
- Delivery verification owns the root Vitest configuration. Keep all existing Anatomia
  test discovery, excluding the new Lapilli dependency whose Node and workspace test
  runners are verified by Lapilli's own review workflow.
