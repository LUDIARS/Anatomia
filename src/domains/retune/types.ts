/**
 * src/domains/retune/types.ts — Domain re-tune: shared types.
 *
 * The re-tune pipeline (spec/feature/domain-retune.md) self-adjusts a project's
 * domain × module taxonomy. This file is types only — no logic, no imports of
 * runtime modules (keeps the data contract loadable everywhere).
 *
 * SRP: type definitions for the taxonomy, the per-node/per-module stats the
 * mechanical steps compute, the LLM step I/O, and the persisted iteration state.
 */

// ── Taxonomy (the committed artifact) ───────────────────────────────────────

/** A module = a named group of nodes owned by path prefixes / name regexes. */
export interface ModulePlan {
  /** kebab-case stable id, unique within the taxonomy. */
  name: string;
  description: string;
  /**
   * Forward-slashed path fragments (treated as JS RegExp source) this module
   * owns. A node belongs to the module when its repo-relative path matches any.
   * Usually a directory prefix, e.g. "src/graph/".
   */
  paths: string[];
  /** Optional function-name regexes (JS RegExp source) the module also owns. */
  names?: string[];
}

/** A domain = a top-level purpose area that groups several modules. */
export interface DomainPlan {
  /** kebab-case stable id, unique within the taxonomy. */
  name: string;
  description: string;
  modules: ModulePlan[];
}

/** The full taxonomy for one project (persisted as JSON under spec/data/ontology). */
export interface Taxonomy {
  version: 1;
  project: string;
  /** How many re-tune passes have shaped this taxonomy. */
  iterations: number;
  domains: DomainPlan[];
  /** Nodes not owned by any module after the run (transparency, not an error). */
  unassigned?: { count: number; sample: string[] };
}

// ── Mechanical graph stats (steps' input) ───────────────────────────────────

/** Per-function summary the mechanical steps reason over. */
export interface NodeSummary {
  id: string;
  name: string;
  /** Repo-relative, forward-slashed path. */
  relPath: string;
  /** Directory of relPath (the natural module candidate), forward-slashed. */
  dir: string;
  cyclomatic: number;
  fanIn: number;
  fanOut: number;
  coupling: number;
  /** Composite size used to rank "large" vs "small" nodes. */
  size: number;
}

/** Per-directory aggregate = a module candidate. */
export interface DirStat {
  dir: string;
  nodeCount: number;
  /** Sum of node sizes in the dir (how "heavy" the dir is). */
  totalSize: number;
  /** Largest functions in the dir (evidence of what it does), name only. */
  representatives: string[];
}

/** Result of classifying nodes by composite size. */
export interface SizeSplit {
  /** Size threshold (inclusive) used to call a node "large". */
  threshold: number;
  large: NodeSummary[];
  small: NodeSummary[];
}

// ── Step logs + report ──────────────────────────────────────────────────────

/** One step's outcome, for the report + human review. */
export interface StepLog {
  step: number;
  title: string;
  /** Whether this step called the LLM. */
  llm: boolean;
  /** Short machine-readable summary of what changed (counts etc.). */
  summary: string;
  /** Optional human-facing notes (low-confidence assignments, dropped items…). */
  notes?: string[];
}

/** The full report from one re-tune pass. */
export interface RetuneReport {
  project: string;
  iteration: number;
  taxonomy: Taxonomy;
  steps: StepLog[];
  /** Files written by the register step (relative to repo root). */
  written: string[];
  /** Absolute ontology dir the generated DomainDefs live in (set as project.ontologyDir). */
  ontologyDir: string;
  /** True when step 7 halts automatic iteration and asks for human judgment. */
  haltForHuman: boolean;
  humanReviewNotes: string[];
}

// ── Domain-review feedback (review → retune 還流) ───────────────────────────

/**
 * Distilled findings of the deterministic domain review handed INTO a retune
 * pass as evidence for the split/merge LLM decisions and the human-review
 * notes. This is a STRUCTURAL SUBSET of review/DomainReviewReport — declared
 * here instead of importing it so the domains layer keeps no dependency on the
 * review layer (one-way layer boundary); a DomainReviewReport is assignable
 * as-is.
 */
export interface DomainReviewSummary {
  domains: DomainReviewDomainStat[];
  boundaryDrift: DomainReviewDriftFinding[];
  overlap: DomainReviewOverlapFinding[];
}

/** Per-domain cohesion/coupling stat (conductance-like calls-edge ratio). */
export interface DomainReviewDomainStat {
  domain: string;
  internalEdges: number;
  boundaryEdges: number;
  /** internal / (internal + boundary); null when the domain touches no edge. */
  cohesion: number | null;
}

/** A function whose calls-neighbourhood majority disagrees with its domain. */
export interface DomainReviewDriftFinding {
  name: string;
  file: string;
  line: number;
  domain: string;
  suggested: string;
  votes: { domain: string; count: number }[];
}

/** A function claimed by multiple domains. */
export interface DomainReviewOverlapFinding {
  name: string;
  file: string;
  line: number;
  domains: string[];
}

// ── Persisted iteration state (.anatomia/retune-state.json, local) ───────────

export interface RetuneState {
  version: 1;
  project: string;
  /** Number of completed re-tune passes. */
  iterations: number;
  /** ISO timestamp of the last pass (stamped by the caller, not in pure code). */
  lastRunAt?: string;
  history: { iteration: number; domains: number; modules: number; unassigned: number }[];
}
