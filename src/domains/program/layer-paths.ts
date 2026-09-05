// @spec プログラムドメイン
/**
 * src/domains/program/layer-paths.ts — Which layer a repo-relative PATH is in.
 *
 * The program-domain derivation classifies MODULES (classify.ts). Two callers
 * need the same answer for a bare path instead: the by-layer domain review
 * (which buckets functions before any module partition exists) and `plan`
 * (which has only `plannedPaths` — those files do not exist yet). Keeping the
 * glob semantics in one place means a repository's `.anatomia/layers.json`
 * means the same thing in all three.
 *
 * SRP: path → layer name. No aggregation, no verdicts.
 */

import { isDependencyArtifactPath } from "./deps.js";
import type { ProgramDomainConfig } from "./types.js";

/** Match a `.anatomia/layers.json` glob against a repo-relative path. */
export function layerGlobMatches(glob: string, value: string): boolean {
  const expression = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§")
    .replace(/\*/g, "[^/]*")
    .replace(/§/g, ".*");
  return new RegExp(`^${expression}$`).test(value.replace(/\\/g, "/"));
}

/**
 * The layer a repo-relative path belongs to, or null when nothing claims it.
 *
 * Config globs come first (the repository's own words), then the builtin
 * dependency-artifact rule. A repository with no declaration therefore claims
 * nothing — which is the honest answer, not an invented layering.
 */
export function layerOfPath(config: ProgramDomainConfig, path: string): string | null {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const rule of config.layers) if (layerGlobMatches(rule.glob, normalized)) return rule.layer;
  if (isDependencyArtifactPath(normalized)) return "infrastructure";
  return null;
}
