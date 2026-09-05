/**
 * src/supply/plan/data-defs.ts — Step 3: what a domain already defines.
 *
 * "まずドメイン定義 → データ定義や重複確認 → 書く" (design §1): before writing,
 * the author needs to see the type and function vocabulary the target domain
 * ALREADY owns, so a new feature extends `VisusCatalog::Entry` instead of
 * inventing a second entry type beside it.
 *
 * The domain's files are the union of (a) the files its analysed implementors
 * live in and (b) the files its declared `membership` path patterns match — (a)
 * alone misses a header/`types.ts` that declares data but no function, and (b)
 * alone misses a domain whose membership is expressed by name pattern.
 *
 * SRP: enumeration of a domain's own definitions. Ranking against the task is
 * duplicates.ts's job.
 *
 * @spec パイプライン（`src/supply/plan/`）
 */

import type { AnchorId } from "../../types.js";
import { isPublicApiName } from "./public-api.js";
import { repoRelative, type PlanRepo } from "./collect.js";
import type { PlanDataDef, PlanDomainCandidate } from "./types.js";

/**
 * How many definitions one plan item lists. A plan is a briefing, not a dump.
 * Types and functions get separate budgets: a domain with dozens of structs
 * would otherwise fill the list and hide every entry point the author needs.
 */
const MAX_TYPES = 8;
const MAX_FUNCTIONS = 6;

/** The repo-relative files a domain owns. */
export function domainFiles(
  repo: PlanRepo,
  domain: string,
  candidate: PlanDomainCandidate | undefined,
): Set<string> {
  const files = new Set<string>();
  const implementors = new Set<AnchorId>(
    (repo.ctx.domains ?? []).find((d) => d.domain === domain)?.implementors ?? [],
  );
  for (const fn of repo.ctx.functions) {
    if (fn.id && implementors.has(fn.id)) {
      files.add(repoRelative(repo.repoPath, fn.sourceRange.filePath));
    }
  }
  for (const pattern of candidate?.pathPatterns ?? []) {
    const regex = compilePattern(pattern);
    if (!regex) continue;
    for (const file of repo.ctx.files) {
      const rel = repoRelative(repo.repoPath, file.path);
      if (regex.test(rel)) files.add(rel);
    }
  }
  return files;
}

/**
 * A membership pattern as a RegExp, or null when the declaration holds an
 * expression this JS runtime rejects. A broken pattern narrows the file set;
 * it must not take the whole plan down, and it is already reported by the
 * ontology loader when the definition is read.
 */
function compilePattern(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/**
 * Type declarations and public API functions of a domain.
 *
 * The function half is the domain's ENTRY POINTS, not everything it defines:
 * accessors and operator overloads are excluded (public-api.ts). Measured on the
 * first plan PR, an unfiltered list ranked by reference count filled 「データ定義」
 * with `size` / `empty` / `count` / `begin` / `end`, which told the author
 * nothing about what the domain is for — accessors are the most-referenced
 * functions in any codebase precisely because they carry no responsibility.
 */
export async function collectDataDefs(
  repo: PlanRepo,
  domain: string,
  candidate: PlanDomainCandidate | undefined,
): Promise<PlanDataDef[]> {
  const files = domainFiles(repo, domain, candidate);
  const types: PlanDataDef[] = [];
  for (const file of repo.ctx.files) {
    const rel = repoRelative(repo.repoPath, file.path);
    if (!files.has(rel)) continue;
    for (const type of file.types ?? []) {
      types.push({ kind: "type", name: type.name, path: rel });
    }
  }

  const functions: { def: PlanDataDef; references: number }[] = [];
  for (const fn of repo.ctx.functions) {
    const rel = repoRelative(repo.repoPath, fn.sourceRange.filePath);
    if (!files.has(rel) || !isPublicApiName(fn.name)) continue;
    const references = fn.id ? (await repo.ctx.graph.fanCounts(fn.id)).fanIn : 0;
    functions.push({ def: { kind: "function", name: fn.name, path: rel }, references });
  }

  const rankedTypes = dedupe(types).sort(byNameThenPath).slice(0, MAX_TYPES);
  const rankedFunctions = dedupe(
    functions
      .sort((a, b) => b.references - a.references || byNameThenPath(a.def, b.def))
      .map((f) => f.def),
  ).slice(0, MAX_FUNCTIONS);
  return [...rankedTypes, ...rankedFunctions];
}

function dedupe(defs: PlanDataDef[]): PlanDataDef[] {
  const seen = new Set<string>();
  const out: PlanDataDef[] = [];
  for (const def of defs) {
    const key = `${def.kind}\0${def.name}\0${def.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(def);
  }
  return out;
}

function byNameThenPath(a: PlanDataDef, b: PlanDataDef): number {
  return a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
}
