/**
 * src/adapters/map-cli.ts — `anatomia map search` / `anatomia map show`.
 *
 * The cross-project entry point (design §12.3). `search` takes the instruction
 * verbatim — 「トランポリンカウンターで連続跳躍を数える」 — and prints the
 * 「プロダクト → コンテンツ → コアドメイン → 主要パス → 関連サービス」 line for
 * each hit; `show` dumps one project's whole map so a repo can check what its
 * declarations actually produced.
 *
 * The exit code is ALWAYS 0, including for a zero-hit search: "the index does
 * not know this" is an answer the caller has to read, not a failure to abort on.
 *
 * SRP: CLI shaping for `map` only. The index lives in src/map/.
 */

import { basename, resolve } from "node:path";
import { ProjectManager } from "../project/manager.js";
import { effectiveOntologyDir } from "../project/config-paths.js";
import { slug } from "../project/registry.js";
import {
  DEFAULT_SEARCH_LIMIT,
  formatProjectMap,
  formatSearchHits,
  loadDomainMapBundle,
  loadProjectDomainMap,
  searchDomainMap,
  type MapProjectSource,
} from "../map/index.js";
import type { CliArgs } from "./cli.js";

/** `map` actions. */
export type MapAction = "search" | "show";

/**
 * Every registered project as a bundle source.
 *
 * `--repo <path>` narrows the bundle to one unregistered checkout so a repo that
 * was never registered can still be searched; without it the search spans the
 * whole registry, which is the point of the map.
 */
export async function resolveMapSources(args: CliArgs): Promise<MapProjectSource[]> {
  if (args.repoExplicit === true) {
    const repoPath = resolve(args.repoPath);
    return [{ id: slug(basename(repoPath)) || "repo", rootPath: repoPath }];
  }
  const manager = await ProjectManager.load();
  const requested = args.projects ?? (args.project ? [args.project] : []);
  const wanted = new Set(requested.map((project) => manager.resolveId(project)));
  return manager
    .list()
    .filter((project) => wanted.size === 0 || wanted.has(project.id))
    .map((project) => ({
      id: project.id,
      rootPath: project.rootPath,
      ontologyDir: effectiveOntologyDir(project),
      cacheDir: manager.cache.dirFor(project.id),
    }));
}

/** Run `map` and render it (text by default, `--json`). */
export async function runMap(args: CliArgs): Promise<{ exitCode: number; output: string }> {
  if (args.mapAction === "show") return runMapShow(args);
  return runMapSearch(args);
}

async function runMapSearch(args: CliArgs): Promise<{ exitCode: number; output: string }> {
  const query = (args.query ?? args.task ?? "").trim();
  if (query === "") {
    return { exitCode: 1, output: 'usage: anatomia map search "<指示文>" [--limit N] [--project <id>]' };
  }
  const sources = await resolveMapSources(args);
  const bundle = await loadDomainMapBundle(sources, { refresh: args.force === true });
  const hits = searchDomainMap(bundle.index, query, { limit: args.limit ?? DEFAULT_SEARCH_LIMIT });
  if (args.json) {
    return {
      exitCode: 0,
      output: JSON.stringify({ query, projects: bundle.index.projects, hits, notes: bundle.notes }, null, 2),
    };
  }
  return { exitCode: 0, output: formatSearchHits(query, hits) };
}

async function runMapShow(args: CliArgs): Promise<{ exitCode: number; output: string }> {
  const wanted = args.query ?? args.project;
  const sources = await resolveMapSources({ ...args, project: wanted, projects: wanted ? [wanted] : [] });
  const source = sources.find((entry) => entry.id === wanted) ?? sources[0];
  if (!source) {
    return { exitCode: 1, output: `no such project "${wanted ?? ""}"` };
  }
  const map = await loadProjectDomainMap(source, { refresh: args.force === true });
  if (args.json) return { exitCode: 0, output: JSON.stringify(map, null, 2) };
  return { exitCode: 0, output: formatProjectMap(map) };
}
