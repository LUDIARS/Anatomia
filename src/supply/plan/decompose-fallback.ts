/**
 * src/supply/plan/decompose-fallback.ts — Step 2b: deterministic decomposition.
 *
 * The decomposition the LLM normally does (§3.2 of the design), done with the
 * detector instead: score every declared domain against the task text and keep
 * the top matches per repo. It is used when the `claude` CLI is unavailable,
 * when `--no-llm` is passed, and whenever the LLM path fails or overruns its
 * deadline — a plan that names real domains beats no plan at all.
 *
 * It is deliberately WEAKER than the LLM path and says so: it cannot invent a
 * per-piece responsibility, cannot name planned paths, and cannot propose a new
 * domain. What it produces is "these declared domains look related", which the
 * enrichment steps then flesh out with real data definitions and exemplars.
 * Where it finds nothing, it records an `unresolved` entry and a question for
 * the human rather than silently returning an empty plan.
 *
 * SRP: task → domain items, without an LLM.
 *
 * @spec パイプライン（`src/supply/plan/`）
 */

import { scoreDomains } from "../detectors.js";
import type { PlanRepo } from "./collect.js";
import type { PlanDomainCandidate, PlanUnresolved } from "./types.js";

/** One domain-sized piece before enrichment (dataDefs/duplicates/exemplar). */
export interface DecomposedItem {
  repo: string;
  domain: string;
  /**
   * Ids of the pieces this one depends on, as stated by the decomposition.
   * The deterministic path leaves it empty — see {@link DEPENDENCY_LIMIT_NOTE}.
   */
  dependsOn?: string[];
  /** The id the LLM used for this piece, so `dependsOn` can be resolved. */
  sourceId?: string;
  status: "existing" | "new";
  responsibility: string;
  plannedPaths: string[];
  neededTypes: string[];
  newDomain?: { name: string; description: string; membership: { pathPattern: string }[] };
}

/** The decomposition step's whole output. */
export interface Decomposition {
  items: DecomposedItem[];
  unresolved: PlanUnresolved[];
  questions: string[];
}

/** How many domains per repo the deterministic path keeps. */
const TOP_PER_REPO = 3;

/**
 * What the deterministic path cannot say about dependencies (A-11).
 *
 * A ranked list of related domains carries no direction between them, and
 * `plannedPaths` is empty here, so guessing an order would invent the very fact
 * the layer warning is about. The limit is recorded in the plan's notes instead.
 */
export const DEPENDENCY_LIMIT_NOTE =
  "決定的検出は item 間の依存方向を確定できないため dependsOn は空です (層間依存の事前警告は出ません)。";

/**
 * Split `task` across `repos` using the domain detector's ranking.
 *
 * `candidates` supplies each domain's declared description, which becomes the
 * item's responsibility text: with no LLM there is nothing better to say about
 * what the piece is for, and the description is at least the repo's own words.
 */
export function decomposeDeterministically(
  task: string,
  repos: PlanRepo[],
  candidates: PlanDomainCandidate[],
): Decomposition {
  const items: DecomposedItem[] = [];
  const unresolved: PlanUnresolved[] = [];
  const questions: string[] = [];

  for (const repo of repos) {
    const declared = new Map(
      candidates.filter((c) => c.repo === repo.id).map((c) => [c.name, c] as const),
    );
    const scored = scoreDomains(repo.ctx, task).slice(0, TOP_PER_REPO);
    if (scored.length === 0) {
      unresolved.push({
        repo: repo.id,
        subject: task,
        reason: declared.size === 0
          ? "このリポジトリにドメイン定義 (spec/domains) がありません"
          : "task に対応するドメインを決定的検出で特定できませんでした",
      });
      questions.push(
        `[${repo.id}] 「${task}」はどのドメインに着地しますか (決定的検出では特定できませんでした)。`,
      );
      continue;
    }
    for (const hit of scored) {
      const candidate = declared.get(hit.name);
      items.push({
        repo: repo.id,
        domain: hit.name,
        status: "existing",
        responsibility: candidate?.description ?? hit.name,
        plannedPaths: [],
        neededTypes: [],
        dependsOn: [],
      });
    }
  }

  return { items, unresolved, questions };
}
