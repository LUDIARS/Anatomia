---
title: Prepared first-query domain navigation
type: feature
service: anatomia
domain: supply-verify
status: draft
tags: [domain, navigation, cache]
---

# Prepared first-query domain navigation {#SPEC-first-query-domain-navigation}

The explicit web-cache prepare step writes a compact catalog and one function shard per business or program domain. The catalog identifies the domain layer, ID, name, function count, and its shard. A shard contains bounded symbol metadata: name, repository-relative path, line, Anchor ID, available source comment, and linked specification references. Business membership comes from approved business-domain view evidence; program membership comes from the code-derived program-domain view. Unmatched evidence is omitted rather than guessed. A matching Anchor ID at more than one location remains multiple occurrences; ambiguous source-location matches remain unresolved.

The producer uses the approved CodeSymbol evidence's source path and zero-based start line to match an analyzed function. CodeSymbol entity IDs and Anchor IDs have different identities. Comment text is prepared from a short bounded block immediately preceding the declaration; unavailable source comments are logged and returned as null. The comment reader is a bounded I/O adapter, while membership projection stays pure.

`anatomia map domains --project <id>` reads only the catalog. `anatomia map functions <domain-id> --project <id>` reads exactly one shard. The HTTP and MCP equivalents return the same prepared projection. Exact domain ID selection is required; a caller may first use the cross-project domain map to discover the project. Function output is capped, stable sorted, and supports `--offset`, `--name`, and `--layer` for precise selection. A business and program domain with the same ID remain distinct.

Queries never analyze, fingerprint the source tree, call an LLM, or rebuild a missing cache. Each response reports its prepare time, source fingerprint at preparation, and `freshness: "unchecked"`: current working-tree freshness has deliberately not been established. Missing, incompatible, or corrupt data returns an explicit prepare-required error; an unknown domain ID returns a distinct error. The current preparation prerequisite is `POST /api/projects/:id/prepare-web-cache`; an ordinary registration or unrelated analysis does not prepare this locator. The prepare process must publish a complete generation before exposing its catalog, so an in-progress update cannot mix old and new shards. Completed generations are retained for concurrent readers and older generations are removed after a grace period.

For bottom-up navigation, `anatomia map function <anchor> --project <id>` consults prepared shards for the function's business/program domains and specification references. This is a supporting path for bug investigation; callers/callees remain available through the existing full-analysis tools when deeper exploration is needed.

## Acceptance and recovery

- Given a prepared project, a first `domains` query reads only the catalog; a first `functions` query reads only the catalog and the selected shard. Neither invokes analysis, source fingerprinting, an LLM, or repository traversal.
- A business domain with approved code evidence returns only matched function occurrences. A spec-only domain remains visible with zero functions. A program domain without an approved business owner remains visible in its own layer.
- Results have deterministic order and a bounded default limit, with `total` and `truncated` so a caller can distinguish an exhaustive answer from a page. Repeated Anchor IDs at different locations remain distinct.
- Missing, incompatible, and malformed prepared data give explicit prepare-required errors. Unknown domain IDs give a separate not-found result. A refresh publishes a complete generation before readers switch to it.
- CLI, HTTP, and MCP entry points use the same read-only projection and report preparation time, source fingerprint at preparation, and unchecked freshness. Refactoring and global investigation are not routed to a pinpoint function query automatically.
- Operators recover by explicitly preparing the project's web cache again. Prior prepared generations may be kept long enough for concurrent readers and removed after the replacement is safely published.
