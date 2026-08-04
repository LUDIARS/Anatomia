# Revisor self-review bootstrap

This directory is a temporary compatibility mirror for the review that lands
the committed-ontology fallback. The currently installed Anatomia CLI always
passes `<review-worktree>/.anatomia/domains` to analysis, so it cannot see the
candidate implementation or the canonical definitions in
`spec/data/ontology` while reviewing itself.

The JSON files here mirror the canonical definitions needed by this diff. They
must be removed in the immediate follow-up after this pull request lands; the
new fallback then makes this legacy directory unnecessary.
