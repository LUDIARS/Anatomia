/**
 * src/review/declared-entrypoints.ts — public entries declared by the repository.
 *
 * "No static caller" and "unused" are different claims. A reusable part may have
 * no production caller in this repo today and still be a documented public API
 * (Ludellus' pose detector: `setPoses` / `update` / `reset` are its contract).
 * `.anatomia/entrypoints.json` is where a repository says so; until now the
 * orphan list ignored it, so the only ways to quiet the finding were deleting
 * the API or adding a dummy call.
 *
 * A declared entry is reported apart from orphans — never as having a caller.
 * Methods of a factory's returned object (`createDetector()` members, see
 * dag/script-types.ts) belong to the factory's contract, so declaring the
 * factory covers them.
 *
 * SRP: match functions against the entry-point config. No call edges are added.
 *
 * @spec Declared entry points in review
 */

import { relative } from "node:path";
import { loadEntryPointConfig, ruleMatches } from "../entrypoints/config.js";
import type { EntryPointConfig } from "../entrypoints/types.js";
import type { AnchorId, FunctionNode } from "../types.js";

const FACTORY_SUFFIX = "()";

/** Anchors the config declares as entries (include minus exclude), plus their factory members. */
export function declaredEntrypointAnchors(
  repoPath: string,
  functions: readonly FunctionNode[],
  config: EntryPointConfig,
): Set<AnchorId> {
  const declared = new Set<AnchorId>();
  if (config.include.length === 0) return declared;
  const pathOf = (fn: FunctionNode): string => relative(repoPath, fn.sourceRange.filePath).replace(/\\/g, "/");
  const isDeclared = (fn: FunctionNode): boolean => {
    const symbol = { anchor: String(fn.id), name: fn.name, path: pathOf(fn) };
    return config.include.some((rule) => ruleMatches(rule, symbol))
      && !config.exclude.some((rule) => ruleMatches(rule, symbol));
  };

  const declaredFactories = new Set<string>();
  for (const fn of functions) {
    if (!fn.id || !isDeclared(fn)) continue;
    declared.add(fn.id);
    if (!fn.enclosingType) declaredFactories.add(`${pathOf(fn)}#${fn.name}${FACTORY_SUFFIX}`);
  }
  for (const fn of functions) {
    if (!fn.id || !fn.enclosingType?.endsWith(FACTORY_SUFFIX)) continue;
    if (declaredFactories.has(`${pathOf(fn)}#${fn.enclosingType}`)) declared.add(fn.id);
  }
  return declared;
}

/** Load the repository's entry-point config and resolve the declared anchors. */
export async function loadDeclaredEntrypoints(
  repoPath: string,
  functions: readonly FunctionNode[],
): Promise<Set<AnchorId>> {
  const { config } = await loadEntryPointConfig(repoPath);
  return declaredEntrypointAnchors(repoPath, functions, config);
}
