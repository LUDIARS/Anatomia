/**
 * src/supply/plan/collect.ts — Step 1: collect the domain candidates (deterministic).
 *
 * A plan can only land work in domains the repos actually declare, so the
 * pipeline starts by reading each project's committed DomainDefs
 * (`spec/domains/*.domain.json`, via the loader's own fallback order) and
 * pairing them with what the analysis found: how many functions the domain owns
 * and which paths it claims. Descriptions are carried through VERBATIM — they
 * are written in Japanese in most LUDIARS repos and are the only text a
 * Japanese task can be matched against.
 *
 * SRP: candidate collection only. Nothing here decides which candidate wins.
 */

import { relative } from "node:path";
import type { AnalysisContext } from "../../core.js";
import { loadEditableDomains } from "../../domains/authoring/store.js";
import { resolveCommittedOntologyDir } from "../../domains/ontology.js";
import type { PlanDomainCandidate } from "./types.js";

/** One repo the plan covers, already analysed. */
export interface PlanRepo {
  /** Project id (registered id, or a slug derived from the path). */
  id: string;
  repoPath: string;
  ctx: AnalysisContext;
  /**
   * Ontology dir to read declarations from. Omitted → the repo's committed
   * dir is resolved (spec/domains, then the legacy locations).
   */
  ontologyDir?: string | undefined;
}

/** Repo-relative, forward-slash form (plans are repo-relative by contract). */
export function repoRelative(repoPath: string, filePath: string): string {
  const rel = relative(repoPath, filePath).replace(/\\/g, "/");
  return rel === "" || rel.startsWith("..") ? filePath.replace(/\\/g, "/") : rel;
}

/**
 * Declared domains of one repo, with implementor counts from its analysis.
 *
 * A domain the repo declares but the analysis found no implementor for is still
 * a candidate: "nobody implements it yet" is precisely the state a plan should
 * be allowed to land new work in.
 */
export async function collectCandidates(repo: PlanRepo): Promise<PlanDomainCandidate[]> {
  const dir = repo.ontologyDir ?? committedDir(repo.repoPath);
  const defs = dir === null || dir === undefined
    ? []
    : await loadEditableDomains(dir, { skipInvalid: true });
  const implementorCounts = new Map<string, number>();
  for (const detected of repo.ctx.domains ?? []) {
    implementorCounts.set(detected.domain, detected.implementors.length);
  }

  const candidates = defs
    .filter((def) => (def.role ?? "semantic") === "semantic")
    .map((def) => ({
      repo: repo.id,
      name: def.name,
      description: def.description,
      pathPatterns: (def.membership ?? [])
        .map((filter) => filter.pathPattern)
        .filter((pattern): pattern is string => typeof pattern === "string"),
      implementors: implementorCounts.get(def.name) ?? 0,
    }));

  // No readable declaration files, but the analysis DID detect domains: the
  // ontology came from an operator plugin dir (ANATOMIA_PLUGIN_DIR / a
  // configured ontologyDir) rather than the repo tree. Planning against the
  // detected domains is still right — only the declared `pathPatterns` are
  // unavailable, which narrows `verify --plan` to the plan's own paths.
  if (candidates.length === 0) {
    for (const detected of repo.ctx.domains ?? []) {
      candidates.push({
        repo: repo.id,
        name: detected.domain,
        description: detected.description ?? "",
        pathPatterns: [],
        implementors: detected.implementors.length,
      });
    }
  }

  return candidates.sort((a, b) => a.name.localeCompare(b.name));
}

/** The repo's committed ontology dir; an unreadable repo path simply has none. */
function committedDir(repoPath: string): string | null {
  try {
    return resolveCommittedOntologyDir(repoPath);
  } catch {
    return null;
  }
}

/** Candidates for every repo, in the order the repos were given. */
export async function collectAllCandidates(repos: PlanRepo[]): Promise<PlanDomainCandidate[]> {
  const out: PlanDomainCandidate[] = [];
  for (const repo of repos) out.push(...(await collectCandidates(repo)));
  return out;
}
