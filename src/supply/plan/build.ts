/**
 * src/supply/plan/build.ts — The `plan` pipeline (design §3.1).
 *
 *   1. collect     (deterministic) — the domains the repos declare
 *   2. decompose   (LLM, with a deterministic fallback) — task → domain pieces
 *   3. dataDefs    (deterministic) — what each target domain already defines
 *   4. duplicates  (deterministic) — what already exists with that vocabulary
 *   5. exemplar    (deterministic) — the implementation to imitate
 *
 * Only step 2 is a judgement; everything else is read off the analysis graph, so
 * two runs over an unchanged repo differ only where the model differs. When the
 * LLM is unavailable, refused (`--no-llm`), failing or over its deadline, the
 * deterministic decomposition runs instead and the reason is recorded in
 * `notes` — the plan says which path produced it rather than presenting a
 * weaker result as the same thing (RULE_CODE §7).
 *
 * SRP: orchestration only. Each step lives in its own file.
 *
 * @spec パイプライン（`src/supply/plan/`）
 */

import { loadProgramDomainConfig } from "../../domains/program/index.js";
import { collectAllCandidates, type PlanRepo } from "./collect.js";
import { DEPENDENCY_LIMIT_NOTE, decomposeDeterministically, type Decomposition } from "./decompose-fallback.js";
import { buildPlanLayerWarnings } from "./layer-warnings.js";
import { decomposeWithLlm, type LlmDecomposeOptions } from "./decompose-llm.js";
import { collectDataDefs, domainFiles } from "./data-defs.js";
import { findDuplicates } from "./duplicates.js";
import { domainLayer, findExemplar } from "./exemplar.js";
import { planHash } from "./store.js";
import { PLAN_VERSION, type Plan, type PlanItem, type PlanSource } from "./types.js";

/** Options for {@link buildPlan}. */
export interface BuildPlanOptions {
  /** Skip the LLM entirely and use the deterministic decomposition. */
  noLlm?: boolean;
  /** Forwarded to the LLM decomposition (model / bin / deadline / injected client). */
  llm?: LlmDecomposeOptions;
  /** Clock, injected so tests get a fixed `generatedAt`. */
  now?: () => Date;
  /**
   * Detection-taxonomy domain names that are UX-critical (A-10), per repo id.
   * Resolved by the caller through approved `domain-owns-code`
   * (`resolveUxCriticalDetectionDomains`) — never by matching names, because the
   * business and detection taxonomies are different namespaces.
   */
  uxCriticalDomains?: Record<string, readonly string[]>;
}

/**
 * Stable ids for the decomposed pieces, plus the map from whatever id the LLM
 * used to ours. `<repo>/<domain>` is readable in the rendered plan; a repeated
 * pair gets a numeric suffix so the id stays unique inside one plan.
 */
function assignItemIds(pieces: readonly { repo: string; domain: string; sourceId?: string }[]): {
  ids: string[];
  bySourceId: Map<string, string>;
} {
  const used = new Map<string, number>();
  const ids: string[] = [];
  const bySourceId = new Map<string, string>();
  pieces.forEach((piece, index) => {
    const base = `${piece.repo}/${piece.domain}`;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    const id = seen === 0 ? base : `${base}#${seen + 1}`;
    ids[index] = id;
    if (piece.sourceId !== undefined && !bySourceId.has(piece.sourceId)) bySourceId.set(piece.sourceId, id);
  });
  return { ids, bySourceId };
}

/** Run the whole pipeline for one task over one or more analysed repos. */
export async function buildPlan(
  task: string,
  repos: PlanRepo[],
  options: BuildPlanOptions = {},
): Promise<Plan> {
  const candidates = await collectAllCandidates(repos);
  const notes: string[] = [];

  let decomposition: Decomposition;
  let source: PlanSource;
  if (options.noLlm) {
    decomposition = decomposeDeterministically(task, repos, candidates);
    source = "deterministic";
    notes.push("--no-llm 指定のため決定的検出のみで分解しました。");
  } else if (candidates.length === 0) {
    decomposition = decomposeDeterministically(task, repos, candidates);
    source = "deterministic";
    notes.push("ドメイン定義が 1 件も無いため LLM 分解を行いませんでした。");
  } else {
    try {
      decomposition = await decomposeWithLlm(task, candidates, options.llm ?? {});
      source = "llm";
    } catch (error) {
      decomposition = decomposeDeterministically(task, repos, candidates);
      source = "deterministic";
      notes.push(
        `LLM 分解に失敗したため決定的検出にフォールバックしました: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const byId = new Map(repos.map((repo) => [repo.id, repo] as const));
  const { ids, bySourceId } = assignItemIds(decomposition.items);
  const items: PlanItem[] = [];
  if (source === "deterministic" && decomposition.items.length > 1) notes.push(DEPENDENCY_LIMIT_NOTE);
  for (const [index, piece] of decomposition.items.entries()) {
    const repo = byId.get(piece.repo);
    if (!repo) continue;
    const candidate = candidates.find((c) => c.repo === piece.repo && c.name === piece.domain);
    const existing = piece.status === "existing";
    const ownFiles = existing ? domainFiles(repo, piece.domain, candidate) : new Set<string>();
    const exemplar = existing ? await findExemplar(repo, piece.domain) : null;
    items.push({
      id: ids[index]!,
      // Only references that resolve to a piece of THIS plan survive; a dangling
      // id would produce a layer warning about an item nobody planned.
      dependsOn: [...new Set((piece.dependsOn ?? [])
        .map((reference) => bySourceId.get(reference) ?? (ids.includes(reference) ? reference : null))
        .filter((id): id is string => id !== null && id !== ids[index]))].sort(),
      uxCritical: (options.uxCriticalDomains?.[piece.repo] ?? []).includes(piece.domain),
      repo: piece.repo,
      domain: piece.domain,
      status: piece.status,
      responsibility: piece.responsibility,
      plannedPaths: piece.plannedPaths,
      ownedPathPatterns: candidate?.pathPatterns ?? piece.newDomain?.membership.map((m) => m.pathPattern) ?? [],
      neededTypes: piece.neededTypes,
      // The exemplar's layer is where a new implementation actually goes. The
      // domain's MAJORITY layer can be somewhere else entirely (Figmentum's
      // kirie-transform owns more vendored files than source files), and
      // telling the author to write into `third_party` would be wrong.
      layer: exemplar?.layer ?? (existing ? domainLayer(repo, piece.domain) : null),
      ...(piece.newDomain ? { newDomain: piece.newDomain } : {}),
      dataDefs: existing ? await collectDataDefs(repo, piece.domain, candidate) : [],
      duplicates: findDuplicates(
        repo,
        { responsibility: piece.responsibility, neededTypes: piece.neededTypes },
        ownFiles,
      ),
      exemplar,
    });
  }

  // A-11: the warnings need the layer declaration of each repo, and a plan may
  // span several. Each repo judges its own items.
  const layerWarnings: Plan["layerWarnings"] = [];
  const layerUnresolved: Plan["unresolved"] = [];
  for (const repo of repos) {
    const config = await loadProgramDomainConfig(repo.repoPath);
    const analysis = buildPlanLayerWarnings(items.filter((item) => item.repo === repo.id), config);
    layerWarnings.push(...analysis.warnings);
    layerUnresolved.push(...analysis.unresolved);
  }

  const repoIds = repos.map((repo) => repo.id);
  return {
    version: PLAN_VERSION,
    task,
    taskHash: planHash(task, repoIds),
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    repos: repoIds,
    source,
    items,
    unresolved: [...decomposition.unresolved, ...layerUnresolved],
    questions: [...new Set(decomposition.questions)],
    notes,
    layerWarnings,
  };
}
