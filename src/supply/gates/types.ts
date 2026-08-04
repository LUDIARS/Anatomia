/**
 * T29 — Shared gate types (DESIGN §9.1 ③).
 *
 * A diff = the set of changed/added functions. Each gate re-derives the affected
 * graph region and returns a GateResult (types.ts). A gate also declares whether
 * it BLOCKS (verdict.pass requires it) or only WARNS.
 *
 * SRP: types + the common DiffInput shape only.
 *
 * @spec verify — 5 ゲート検証パイプライン
 */

import type {
  AnchorId,
  FunctionNode,
  GateResult,
  Rule,
  SpecClause,
} from "../../types.js";
import type { CodeGraphQuery } from "../../graph/query.js";
import type { EmbeddingClient } from "../../spec/semantic.js";
import type { Link } from "../../types.js";
import type { Thresholds } from "../thresholds.js";
import type { DomainMembership } from "../metrics.js";

/**
 * The change under review. `changed` are the new/added FunctionNodes (already
 * hashed -> have non-null `id`). `graph` is the post-change code graph so gates
 * can query the affected region. `baseGraph` (optional) is the pre-change graph
 * for delta comparisons.
 */
export interface DiffInput {
  /** New/added/changed functions (post-change, hashed). */
  changed: FunctionNode[];
  /** Post-change code graph (G2). */
  graph: CodeGraphQuery;
  /** Pre-change code graph, for delta gates (coupling_delta). Optional. */
  baseGraph?: CodeGraphQuery;
  /** Rules in effect (global ∪ domain), for rule_conformance. */
  rules?: Rule[];
  /** Domain membership (G3), for duplication + coupling delta context. */
  membership?: DomainMembership;
  /** Existing domain cards' text (for duplication embedding compare). */
  domainCards?: { domain: string; text: string }[];
  /** Spec clauses + existing links (G4), for spec_linkage. */
  specClauses?: SpecClause[];
  links?: Link[];
  /** Repo-relative thresholds (T26), for coupling_delta. */
  thresholds?: Thresholds;
  /** Sibling functions defining conventions, for convention_drift. */
  siblings?: FunctionNode[];
}

/** A gate is an async function diff -> GateResult, plus a block/warn flag. */
export interface Gate {
  /** Gate name (matches GateResult.gate). */
  readonly name: GateResult["gate"];
  /** block = required for verdict.pass; warn = advisory only. */
  readonly severity: "block" | "warn";
  run(input: DiffInput): Promise<GateResult>;
}

/** Convenience: anchors of the changed functions (non-null ids). */
export function changedAnchors(input: DiffInput): AnchorId[] {
  return input.changed.map((f) => f.id).filter((id): id is AnchorId => id !== null);
}

/**
 * True when the path is test code (`__tests__/` directory or `*.test.* /
 * *.spec.*` file). Test bodies orchestrate many helpers and assertions by
 * design, so architectural gates (spec_linkage orphans, coupling_delta) treat
 * them as verification artifacts, not production surfaces — the same
 * production/test boundary `review/pr-diff.ts` draws for changed orphans.
 */
export function isTestFilePath(filePath: string): boolean {
  return /(^|[\\/])__tests__([\\/]|$)|\.(?:test|spec)\.[^\\/]+$/i.test(filePath);
}

/** Changed functions that live in production (non-test) files. */
export function productionChanged(input: DiffInput): FunctionNode[] {
  return input.changed.filter((f) => !isTestFilePath(f.sourceRange.filePath));
}

/** Injected embedding client carrier for the duplication gate (mockable). */
export interface DuplicationDeps {
  embed: EmbeddingClient;
  /** Cosine threshold above which new code is "too similar". Default 0.85. */
  similarityThreshold?: number;
}
