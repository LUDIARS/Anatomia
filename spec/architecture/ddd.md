---
title: Anatomia domain navigation boundaries
type: architecture
service: anatomia
status: draft
---

# Domain navigation boundaries

Anatomia distinguishes business domains (approved specification ownership) from program domains (code-derived module and layer groups). A business domain may have no code; a program domain may have no approved business owner. Navigation must preserve both cases instead of inventing ownership.

The knowledge log and the prepared business/program domain views own domain identity and membership. Source analysis owns function names, locations, and Anchor IDs. The first-query locator is a disposable projection of those facts. Preparing it is an explicit update operation; reading it must not parse source, walk the repository fingerprint, invoke an LLM, or infer a new relationship.

The locator serves feature investigation from a named domain to a bounded set of functions. Refactoring and global research can use the catalog without being forced through a single-function landing. A function result includes source comments and specification references to help a bug investigation continue in the reverse direction.

The locator supports UX-AN-W1 by making a prepared domain's landing functions immediately available, UX-AN-W3 by retaining stable Anchor IDs without collapsing distinct source occurrences, and UX-AN-W4 by preserving approved domain/specification evidence. Its invariant is that unknown or ambiguous ownership remains explicit: a matching function name, path, or Anchor ID cannot create an unapproved business-domain relationship. Preparation is an update boundary and must publish its catalog and shards as one coherent generation. A query only opens the prepared catalog and requested shard; stale or missing prepared data is reported rather than rebuilt implicitly.
