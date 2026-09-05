/**
 * src/map/bundle.ts — Every registered project, folded into one live index.
 *
 * The map is only worth having if it is CROSS-project: a task names a product
 * before it names a repo. So the bundle walks the registry, gets each project's
 * records, and hands search.ts a single index (design §12.3).
 *
 * Rebuild policy, cheapest first:
 *   1. the process memo, when the project's `sourceKey` is unchanged
 *   2. the prepared web-cache artifact (`domain-map`), same check
 *   3. a fresh build from the repo's declarations
 *
 * `sourceKey` is the map's own content-addressed change detection (sources.ts):
 * a project whose declarations did not change is never rebuilt, and one that did
 * is rebuilt ALONE — the other projects keep their entries. That is the "差分
 * 再構築" the design asks for, without a second cache format.
 *
 * SRP: assembling + refreshing the bundle. Building one project is sources.ts.
 */
// @implements SPEC-domain-map

import { computeMapSourceKey, buildProjectDomainMap, type MapProjectInput } from "./sources.js";
import {
  clearProjectRootMemo,
  normalizeMapSources,
  type NormalizeSourcesOptions,
} from "./project-roots.js";
import { buildDomainMapIndex, type DomainMapIndex } from "./inverted-index.js";
import {
  fetchProjectCodes,
  projectCodesKey,
  type ProjectCode,
  type ProjectCodesOptions,
} from "./project-codes.js";
import { resolveCommittedOntologyDir } from "../domains/ontology.js";
import { readWebView } from "../web-cache/store.js";
import { DOMAIN_MAP_VERSION, type ProjectDomainMap } from "./types.js";

/** One project the bundle covers. */
export interface MapProjectSource extends MapProjectInput {
  /** Project cache dir, when the prepared `domain-map` artifact may be reused. */
  cacheDir?: string | undefined;
}

/** The bundled index plus what it was built from. */
export interface DomainMapBundle {
  index: DomainMapIndex;
  maps: ProjectDomainMap[];
  /** Per-project diagnostics worth showing (missing declarations, roster down). */
  notes: string[];
}

/** Options for {@link loadDomainMapBundle}. */
export interface LoadBundleOptions extends NormalizeSourcesOptions {
  /** Skip the process memo and the prepared artifact (tests, `--refresh`). */
  refresh?: boolean;
  /** Pre-fetched roster; omitted → fetched once from Concordia. */
  roster?: { codes: ProjectCode[]; error: string | null };
  /** Forwarded to the roster fetch. */
  projectCodes?: ProjectCodesOptions;
  /** Lifetime of the default roster lookup memo. */
  rosterCacheMs?: number;
  /** How long a warm map may be reused before its source bytes are rechecked. */
  sourceCheckIntervalMs?: number;
  /** Monotonic-enough wall clock for cache expiry tests. */
  nowMs?: () => number;
  now?: () => Date;
}

/**
 * Process memo of the newest map per project.
 *
 * Module-level on purpose: the warm server answers many searches per minute and
 * every one of them would otherwise rescan every repo's declarations.
 */
const memo = new Map<string, ProjectDomainMap>();
const memoCheckedAt = new Map<string, number>();
const inFlight = new Map<string, Promise<ProjectDomainMap>>();
let memoEpoch = 0;
const DEFAULT_ROSTER_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_SOURCE_CHECK_INTERVAL_MS = 30_000;
let rosterMemo: {
  expiresAt: number;
  owner: ProjectCodesOptions | undefined;
  value: { codes: ProjectCode[]; error: string | null };
} | null = null;

/** Drop the process memo (tests, and after a registry change). */
export function clearDomainMapMemo(): void {
  memoEpoch++;
  memo.clear();
  memoCheckedAt.clear();
  inFlight.clear();
  rosterMemo = null;
  clearProjectRootMemo();
}

/** Build (or refresh) the bundle over `sources`. */
export async function loadDomainMapBundle(
  sources: MapProjectSource[],
  options: LoadBundleOptions = {},
): Promise<DomainMapBundle> {
  if (sources.length === 0) {
    return { index: buildDomainMapIndex([]), maps: [], notes: [] };
  }
  // A shared registry outlives the checkouts in it: drop the roots that are gone
  // and fold repeat registrations of one repository before anything is indexed,
  // so one repo never spends two of the search's few result slots on the same
  // content (project-roots.ts).
  const registry = await normalizeMapSources(sources, options);
  const roster = options.roster ?? (await resolveRoster(options));
  const maps: ProjectDomainMap[] = [];
  const notes: string[] = [...registry.notes];
  for (const source of registry.sources) {
    const map = await loadProjectDomainMap(source, {
      ...options,
      roster,
    });
    maps.push(map);
    for (const note of map.notes) notes.push(`[${map.project}] ${note}`);
  }
  return { index: buildDomainMapIndex(maps), maps, notes };
}

/** One project's map, reusing the memo / artifact while its sources are unchanged. */
export async function loadProjectDomainMap(
  source: MapProjectSource,
  options: LoadBundleOptions = {},
): Promise<ProjectDomainMap> {
  const ontologyDir = source.ontologyDir ?? committedOntologyDir(source.rootPath);
  const roster = options.roster ?? (await resolveRoster(options));
  const rosterKey = projectCodesKey(roster);
  const now = options.nowMs?.() ?? Date.now();
  const epoch = memoEpoch;
  const memoKey = `${source.id}\0${source.rootPath}`;
  const loadKey = `${memoKey}\0${rosterKey}`;

  if (options.refresh !== true) {
    const cached = memo.get(memoKey);
    const checkedAt = memoCheckedAt.get(memoKey) ?? 0;
    const checkInterval = Math.max(
      0,
      options.sourceCheckIntervalMs ?? DEFAULT_SOURCE_CHECK_INTERVAL_MS,
    );
    if (cached && cached.rosterKey === rosterKey && now - checkedAt < checkInterval) {
      return cached;
    }
    const pending = inFlight.get(loadKey);
    if (pending) return pending;
  }

  const load = loadProjectDomainMapChecked(
    source,
    ontologyDir,
    roster,
    rosterKey,
    memoKey,
    epoch,
    now,
    options,
  );
  if (options.refresh === true) return load;
  inFlight.set(loadKey, load);
  try {
    return await load;
  } finally {
    if (inFlight.get(loadKey) === load) inFlight.delete(loadKey);
  }
}

async function loadProjectDomainMapChecked(
  source: MapProjectSource,
  ontologyDir: string | null,
  roster: { codes: ProjectCode[]; error: string | null },
  rosterKey: string,
  memoKey: string,
  epoch: number,
  checkedAt: number,
  options: LoadBundleOptions,
): Promise<ProjectDomainMap> {
  const sourceKey = await computeMapSourceKey(source.rootPath, ontologyDir);
  const cached = memo.get(memoKey);
  if (options.refresh !== true && cached?.sourceKey === sourceKey && cached.rosterKey === rosterKey) {
    if (memoEpoch === epoch) memoCheckedAt.set(memoKey, checkedAt);
    return cached;
  }
  if (options.refresh !== true) {
    const prepared = await readPrepared(source, sourceKey, rosterKey);
    if (prepared) {
      if (memoEpoch === epoch) {
        memo.set(memoKey, prepared);
        memoCheckedAt.set(memoKey, checkedAt);
      }
      return prepared;
    }
  }

  const built = await buildProjectDomainMap(
    { ...source, ontologyDir: ontologyDir ?? undefined },
    {
      roster: roster.codes,
      rosterError: roster.error,
      sourceKey,
      ...(options.now ? { now: options.now } : {}),
    },
  );
  if (memoEpoch === epoch) {
    memo.set(memoKey, built);
    memoCheckedAt.set(memoKey, checkedAt);
  }
  return built;
}

/** The prepared `domain-map` artifact, when it matches the current sources. */
async function readPrepared(
  source: MapProjectSource,
  sourceKey: string,
  rosterKey: string,
): Promise<ProjectDomainMap | null> {
  if (!source.cacheDir) return null;
  try {
    const env = await readWebView<ProjectDomainMap>(source.cacheDir, "domain-map");
    const data = env?.data;
    if (!data || data.version !== DOMAIN_MAP_VERSION) return null;
    return data.sourceKey === sourceKey && data.rosterKey === rosterKey
      ? { ...data, project: source.id }
      : null;
  } catch {
    return null;
  }
}

/**
 * The registry, as bundle sources.
 *
 * Typed structurally rather than against ProjectManager so the map layer does
 * not depend on the project layer's whole lifecycle — the bundle needs a list of
 * (id, root, ontology, cache dir) and nothing more.
 */
export interface RegistryLike {
  list(): { id: string; rootPath: string; ontologyDir?: string | undefined }[];
  cacheDirFor(id: string): string | undefined;
}

/** Every registered project as a bundle source, in registry order. */
export function sourcesFromRegistry(registry: RegistryLike): MapProjectSource[] {
  return registry.list().map((project) => ({
    id: project.id,
    rootPath: project.rootPath,
    ontologyDir: project.ontologyDir,
    cacheDir: registry.cacheDirFor(project.id),
  }));
}

async function resolveRoster(
  options: LoadBundleOptions,
): Promise<{ codes: ProjectCode[]; error: string | null }> {
  const now = Date.now();
  if (
    options.refresh !== true
    && rosterMemo
    && rosterMemo.owner === options.projectCodes
    && rosterMemo.expiresAt > now
  ) {
    return rosterMemo.value;
  }
  const value = await fetchProjectCodes(options.projectCodes ?? {});
  rosterMemo = {
    value,
    owner: options.projectCodes,
    expiresAt: now + Math.max(0, options.rosterCacheMs ?? DEFAULT_ROSTER_CACHE_MS),
  };
  return value;
}

function committedOntologyDir(repoPath: string): string | null {
  try {
    return resolveCommittedOntologyDir(repoPath);
  } catch {
    return null;
  }
}
