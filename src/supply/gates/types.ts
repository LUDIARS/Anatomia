/**
 * T29 — Shared gate types (DESIGN §9.1 ③).
 *
 * A diff = the set of changed/added functions. Each gate re-derives the affected
 * graph region and returns a GateResult (types.ts). A gate also declares whether
 * it BLOCKS (verdict.pass requires it) or only WARNS.
 *
 * SRP: types + the common DiffInput shape only.
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
import type { MechanicMembership } from "../metrics.js";

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
  /** Rules in effect (global ∪ mechanic), for rule_conformance. */
  rules?: Rule[];
  /** Mechanic membership (G3), for duplication + coupling delta context. */
  membership?: MechanicMembership;
  /** Existing mechanic cards' text (for duplication embedding compare). */
  mechanicCards?: { mechanic: string; text: string }[];
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

/** Injected embedding client carrier for the duplication gate (mockable). */
export interface DuplicationDeps {
  embed: EmbeddingClient;
  /** Cosine threshold above which new code is "too similar". Default 0.85. */
  similarityThreshold?: number;
}
