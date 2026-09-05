/**
 * src/supply/plan/hints.ts — Step 0: which projects and domains, from the map.
 *
 * `plan` used to start from a project the CALLER already knew (`--project`, or
 * the cwd). That is exactly the knowledge a Japanese instruction does not carry:
 * 「トランポリンカウンターで〇〇」 names a product, not a repo. The cross-project
 * domain map (src/map/) answers that, so the plan's first step is now a
 * millisecond index search whose hits become the `--project` candidates and the
 * domain hints (design §12.3).
 *
 * A ZERO-hit search is not a failure and must not be silent: the design says it
 * becomes a plan QUESTION (「索引に無い。新規コンテンツか表記ゆれ」), because an
 * instruction the index cannot place is either new content or a spelling the
 * repos never wrote down — both are decisions for the human, not for the tool.
 *
 * SRP: map hits → plan inputs. Ranking lives in map/search.ts.
 */
// @implements SPEC-domain-map

import {
  DEFAULT_SEARCH_LIMIT,
  NO_HIT_MESSAGE,
  loadDomainMapBundle,
  searchDomainMap,
  type DomainMapHit,
  type LoadBundleOptions,
  type MapProjectSource,
} from "../../map/index.js";

/** How many distinct projects the hints propose before the list stops helping. */
const MAX_PROJECTS = 3;

/** How many domain hints are carried into the decomposition. */
const MAX_DOMAINS = 5;

/**
 * A project whose best hit scores below this share of the TOP hit is not a
 * project the task is about.
 *
 * An exact alias hit outranks token overlap by two orders of magnitude
 * (map/search.ts), so when the map recognised the product by name, everything
 * else in the result set is background noise — and each extra project here costs
 * a full `analyze()`. When no alias matched, the hits are all token-level and
 * close together, which is exactly the cross-repo case (Pictor + Figmentum for
 * 「切り絵のデモ」) the map exists to surface.
 */
const RELEVANCE_FLOOR = 0.05;

/** What the map contributed to a plan. */
export interface PlanMapTarget {
  project: string;
  domain: string;
}

/** What the map contributed to a plan. */
export interface PlanMapHints {
  /** Project ids to plan over, best first. */
  projects: string[];
  /** Core domains the hits landed in, best first. */
  domainHints: string[];
  /** Project-qualified domains; this is the authoritative landing association. */
  targets: PlanMapTarget[];
  /** The hits themselves, for the plan's preface line. */
  hits: DomainMapHit[];
  /** Questions the map produced (the zero-hit case). */
  questions: string[];
  /** Diagnostics from bundling (missing declarations, roster unavailable). */
  notes: string[];
}

/** Options for {@link collectMapHints}. */
export interface CollectMapHintsOptions extends LoadBundleOptions {
  limit?: number;
  /** Restrict the search to these project ids (an explicit `--project`). */
  projects?: string[];
}

/** Search the bundled map for `task` and shape the result as plan inputs. */
export async function collectMapHints(
  task: string,
  sources: MapProjectSource[],
  options: CollectMapHintsOptions = {},
): Promise<PlanMapHints> {
  const bundle = await loadDomainMapBundle(sources, options);
  const hits = searchDomainMap(bundle.index, task, {
    limit: options.limit ?? DEFAULT_SEARCH_LIMIT,
    ...(options.projects && options.projects.length > 0 ? { projects: options.projects } : {}),
  });
  return fromHits(task, hits, bundle.notes);
}

/**
 * Shape already-ranked hits as plan inputs.
 *
 * Split out from the search so a caller that already has hits (the warm server's
 * route, a test) does not rebuild the bundle to reuse the same rules.
 */
export function fromHits(task: string, hits: DomainMapHit[], notes: string[] = []): PlanMapHints {
  const projects: string[] = [];
  const floor = (hits[0]?.score ?? 0) * RELEVANCE_FLOOR;
  for (const hit of hits) {
    if (hit.score < floor) continue;
    if (!projects.includes(hit.project) && projects.length < MAX_PROJECTS) projects.push(hit.project);
  }
  const targets: PlanMapTarget[] = [];
  for (const hit of hits) {
    if (hit.score < floor || !projects.includes(hit.project) || !hit.coreDomain) continue;
    const target = { project: hit.project, domain: hit.coreDomain };
    if (targets.some((entry) => entry.project === target.project && entry.domain === target.domain)) continue;
    if (targets.length >= MAX_DOMAINS) break;
    targets.push(target);
  }
  const domainHints = [...new Set(targets.map((target) => target.domain))];
  const questions = hits.length === 0
    ? [`[domain-map] 「${task}」 は${NO_HIT_MESSAGE} 対象プロダクトを指定してください。`]
    : [];
  return { projects, domainHints, targets, hits, questions, notes };
}
