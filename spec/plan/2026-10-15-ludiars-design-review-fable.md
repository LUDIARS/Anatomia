---
title: LUDIARS 9-tool design review — Anatomia
type: plan
status: proposed
service: anatomia
domain: tooling
updated: 2026-10-17
tags: [design-review, cross-service]
---

# Anatomia: prepared views and accurate discovery

## Ownership and common priorities

An owns implementation analysis, Anchor IDs, derived code/domain views and their
knowledge provenance. Pf owns the source specification/design; Cc owns sessions;
Actio owns task status; Augur owns test planning/evidence; Rv owns review/merge;
Br derives summaries; Cf owns game adoption; Genius owns private judgment cards.
Share identities and bounded projections before consolidating independent stores.

Reviewed main: `d4d68a2`. Sources: CLAUDE.md, spec/README.md,
spec/interface/cli.md, spec/interface/mcp.md, src/adapters/cli.ts,
src/adapters/mcp.ts, src/cache/redis-store.ts, src/providers/concordia-cost.ts,
spec/architecture/ddd.md and spec/ux/product.md.

## Verified findings and rebuttals

| Finding | Checked fact / qualification | Decision |
|---|---|---|
| CLI specification omits three accepted commands. | parseArgs accepts entrypoints, knowledge and map in addition to the documented list. | Add the commands to the interface index; do not invent unsupported test-suggestions. |
| MCP specification says 11 tools. | _registerTools declares 17 names; six (scenes, knowledge.*, projects.*) follow the hasManager guard. | Document 11 unconditional plus six conditional tools and their inputs. |
| Folder rule forbids existing spec classifications. | CLAUDE.md lists five; repository has ten, including architecture/domains/plan/tasks/ux. | Align the rule and index with existing structure; do not claim unverified CI enforcement. |
| Redis is described as silently unavailable. | redis-store.ts already emits one connection-failure warning; individual cache misses remain best-effort. | Original broad claim weakened. Preserve optional-cache availability; assess observability without converting every miss to a fatal error. |
| Cc cost endpoint has defaults. | concordia-cost.ts uses CONCORDIA_URL then host/port defaults. | Requiring env changes reporting behaviour. Propose explicit topology/readiness, not an unreviewed default removal. |
| Multiple analysis paths may be costly. | CLI and MCP provide broad analysis; the DDD specification explicitly separates prepared map queries from parsing or implicit rebuilding. | Prefer bounded prepared reads for navigation, while keeping deliberate full analysis for refactoring. No latency improvement is claimed without measurement. |

## Implemented and validated

Documentation/interface corrections only: folder rule and spec index, three CLI
entries, six missing MCP entries and availability conditions. UX-AN-W1/W3/W4:
callers can discover the actual surface without requesting nonexistent tools or
mistaking a prepared lookup for a fresh analysis. Program behaviour and approved
business-domain ownership are unchanged.

Static validation compares the documented MCP names to registration literals and
checks the advertised folders exist. No source code was changed, so no synthetic
unit test that mirrors the text was added. Direct tests/build/live MCP were not
executed. Revisor remains the review gate. Human UX accuracy is not declared.
Recovery is a document revert; no migration, cache rebuild or restart is needed.

## Ordered proposals

1. **An/Rv/Br:** agree on a revision-bound prepared-domain summary with counts,
   unknown/unclassified cases and freshness. Br should consume that projection
   rather than reimplement ownership matching. Acceptance: identical numerator,
   denominator, source revision and unknown behaviour on a shared fixture corpus.
2. **An/Pf:** keep specification content in each repository; exchange immutable
   source/version references and approved ownership evidence. Ambiguous anchors
   must remain ambiguous rather than inheriting an approved relationship.
3. **An/Cc:** make cost delivery topology and failed-delivery queue visible;
   choose a single cost authority before moving its state. Compare outage/retry
   behaviour before retiring defaults.
4. **Cache lifecycle:** measure cold/warm timings and hit ratios by operation.
   Do not conflate optional remote cache failure with missing required providers.

Remaining: measurements and owner-provided cross-service projections. Historical
Workflow reader/scout jobs were not rerun and are not represented as completed.
