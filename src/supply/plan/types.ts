/**
 * src/supply/plan/types.ts — `anatomia plan` data shapes.
 *
 * A PLAN is the work-breakdown a coding task is split into BEFORE code is
 * written: which declared domain each responsibility lands in, what data
 * definitions that domain already owns, what already exists that would be
 * duplicated, and which existing implementation to imitate. It is produced by
 * `anatomia plan`, persisted under `.anatomia/plan/`, and read back by
 * `verify --plan` so the files a PR actually touched can be checked against the
 * domains the work was planned into.
 *
 * SRP: type definitions only. Collection, decomposition, enrichment and
 * rendering each live in their own file in this directory.
 *
 * @spec ドメイン先行コーディングの実態と `anatomia plan` ツール化
 */

/** Schema version of a persisted plan; bumped when the shape changes. */
export const PLAN_VERSION = "plan-v2";

/** How the task was split into domains. */
export type PlanSource = "llm" | "deterministic";

/** A domain a plan may land work in, as declared by a repo. */
export interface PlanDomainCandidate {
  /** Project id the domain belongs to. */
  repo: string;
  name: string;
  /** The declaration's own description (Japanese in most LUDIARS repos). */
  description: string;
  /** `membership[].pathPattern` sources — the paths the domain owns. */
  pathPatterns: string[];
  /** How many analysed functions the domain currently owns. */
  implementors: number;
}

/** A type/function definition a domain already owns. */
export interface PlanDataDef {
  kind: "type" | "function";
  name: string;
  /** Repo-relative path of the declaring file. */
  path: string;
}

/** An existing implementation that looks like what the task asks for. */
export interface PlanDuplicate {
  name: string;
  path: string;
  /** 0..1 token overlap against the responsibility + needed types. */
  score: number;
}

/** The existing implementation a new one should be modelled on. */
export interface PlanExemplar {
  /** Anchor of the exemplar function, when it has one. */
  anchor: string | null;
  name: string;
  path: string;
  layer: string | null;
  references: number;
}

/** A new domain the task needs, proposed for human review. */
export interface PlanNewDomain {
  name: string;
  description: string;
  membership: { pathPattern: string }[];
}

/** A layer-direction warning between two plan items (A-11). */
export interface PlanLayerWarning {
  fromItemId: string;
  toItemId: string;
  fromLayer: string;
  toLayer: string;
  /** Why the direction is suspect, in the reviewer's language. */
  reason: string;
}

/** One domain-sized piece of the task. */
export interface PlanItem {
  /**
   * Stable id inside this plan (`<repo>/<domain>`, disambiguated when a repo
   * plans the same domain twice). Dependency edges reference it, so it has to
   * survive persistence and re-read.
   */
  id: string;
  /**
   * Ids of the items this piece depends on. Stated by the decomposition, never
   * inferred from `plannedPaths` (paths carry no direction). Empty when the
   * deterministic fallback could not state them — see the plan's `notes`.
   */
  dependsOn: string[];
  /**
   * The landing domain is UX-critical (A-10), resolved through approved
   * `domain-owns-code` rather than a name match. Raises the review bar and makes
   * test candidates mandatory.
   */
  uxCritical: boolean;
  /** Project id this piece lands in. */
  repo: string;
  /** Domain name — an existing declaration, or the proposed new one. */
  domain: string;
  status: "existing" | "new";
  /** What this piece is responsible for, in the task's own language. */
  responsibility: string;
  /** Repo-relative paths the work is expected to touch. */
  plannedPaths: string[];
  /**
   * The domain's declared `membership[].pathPattern` sources, copied into the
   * plan so `verify --plan` can judge a diff without re-reading the ontology
   * (the review checkout may not be the one the plan was made in).
   */
  ownedPathPatterns: string[];
  /** Types the piece needs (input to the duplicate search). */
  neededTypes: string[];
  /** Top-level dir the domain mostly lives in, when one dominates. */
  layer: string | null;
  /** Present when `status` is "new": the declaration to add in the same PR. */
  newDomain?: PlanNewDomain;
  /** Data definitions the domain already owns. */
  dataDefs: PlanDataDef[];
  /** Existing implementations that may already do this. */
  duplicates: PlanDuplicate[];
  /** The implementation to imitate. */
  exemplar: PlanExemplar | null;
}

/**
 * A responsibility (or path) the pipeline could NOT bind to a domain.
 *
 * Recorded rather than dropped or guessed: an unbindable piece is exactly the
 * decision a human has to make, and `questions` carries it to them. The plan is
 * still usable — implementation proceeds without waiting for the answer, and
 * the unresolved entry is what the post-implementation review reconciles.
 */
export interface PlanUnresolved {
  repo: string;
  /** The responsibility text or path that could not be bound. */
  subject: string;
  reason: string;
}

/** A full domain plan for one task. */
export interface Plan {
  version: typeof PLAN_VERSION;
  /** The task, verbatim. */
  task: string;
  /** Stable hash of task + repos; also the persisted file's basename. */
  taskHash: string;
  /** ISO timestamp of generation (metadata; not part of the hash). */
  generatedAt: string;
  /** Project ids the plan covers, in the order given. */
  repos: string[];
  /** Repo id this persisted copy belongs to; omitted on an in-memory plan. */
  storedForRepo?: string;
  source: PlanSource;
  items: PlanItem[];
  unresolved: PlanUnresolved[];
  /** Questions for the human (new-domain wording, unbound responsibilities). */
  questions: string[];
  /** Diagnostics worth showing: why the LLM path was not used, etc. */
  notes: string[];
  /** Layer-direction warnings over `items[].dependsOn` (A-11). */
  layerWarnings: PlanLayerWarning[];
}
