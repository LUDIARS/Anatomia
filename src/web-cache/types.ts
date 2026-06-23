/**
 * src/web-cache/types.ts — Prepared web-display cache: data contract.
 *
 * The web panel does NOT compute views on demand. A project is explicitly
 * "prepared" (a button → POST .../prepare-web-cache) which builds every view
 * once and persists it under <cacheRoot>/<projectId>/web/. The panel then renders
 * ONLY from this prepared cache — a view with no prepared file is not rendered;
 * the panel shows an error + a "prepare" prompt instead (the user's invariant:
 * 「キャッシュが無い場合描画してはならない」).
 *
 * Web data need not be fresh: each prepared file carries its own `preparedAt`
 * generation date and the source `fingerprint` at prepare time, so the panel can
 * surface "prepared 3h ago / source changed since" without ever auto-rebuilding.
 *
 * SRP: type definitions only. Builders live in build.ts + the per-view modules;
 * persistence in store.ts.
 */

import type { EdgeKind } from "../types.js";

/** The set of views the prepare step builds + the panel renders from cache. */
export type WebViewName =
  | "graph"
  | "domain-view"
  | "hotspots"
  | "spec-links"
  | "domains"
  | "scene-modules"
  | "search-corpus";

/** All view names, in render order (also the prepare build order). */
export const WEB_VIEWS: readonly WebViewName[] = [
  "graph",
  "domain-view",
  "hotspots",
  "spec-links",
  "domains",
  "scene-modules",
  "search-corpus",
] as const;

/**
 * One prepared view, on disk as <view>.json. Carries its own generation date so
 * every view independently answers "when was this built" — the panel stamps each
 * tab with it.
 */
export interface WebViewEnvelope<T = unknown> {
  version: 1;
  view: WebViewName;
  /** ISO generation date of THIS view. */
  preparedAt: string;
  /** Source fingerprint at prepare time (for the panel's stale indicator). */
  fingerprint: string;
  data: T;
}

/** The manifest written alongside the view files (the index of a prepared cache). */
export interface WebCacheManifest {
  version: 1;
  projectId: string;
  /** ISO generation date of the whole prepare run. */
  preparedAt: string;
  /** Source fingerprint at prepare time. */
  fingerprint: string;
  /** Views that were built (present on disk). */
  views: WebViewName[];
  /** Per-view row/entry counts (panel badges, transparency). */
  counts: Partial<Record<WebViewName, number>>;
}

// ── scene-modules view ──────────────────────────────────────────────────────

/** One edge bucket from a module to another module (where this module accesses). */
export interface ModuleAccess {
  /** Target module id (taxonomy module name, or directory when no taxonomy). */
  targetModuleId: string;
  targetLabel: string;
  /** Domains the target module participates in (best-effort, may be empty). */
  targetDomains: string[];
  /** Total edges from this module into the target. */
  count: number;
  /** Edge-kind breakdown (calls/reads/writes/…). */
  kinds: Partial<Record<EdgeKind, number>>;
}

/** A module under a domain, with the precomputed facts the view needs. */
export interface SceneModuleNode {
  moduleId: string;
  label: string;
  /** #functions in the whole module. */
  functionCount: number;
  /** #functions this domain owns inside the module (its slice). */
  domainFunctionCount: number;
  /** Module cohesion 0..1, or null when unknown. */
  cohesion: number | null;
  /** #violations (of this domain) that touch a function in this module. */
  violationCount: number;
  /** Where this module accesses (outgoing module→module edges). */
  accesses: ModuleAccess[];
}

/** A domain row (the view is domain-centred) with its modules. */
export interface SceneDomainNode {
  domain: string;
  conforms: boolean;
  violationCount: number;
  /** Scene ids (局面) that activate this domain. */
  scenes: string[];
  modules: SceneModuleNode[];
}

/** A scene-state node (局面): id + the domains it activates. */
export interface SceneNode {
  id: string;
  label?: string;
  domains: string[];
}

/**
 * The scene-state → domain → module view: only this hierarchy, domain-centred,
 * every module pre-decorated with functionCount / accesses / violations.
 */
export interface SceneModulesPayload {
  /** True when a real trace fed the scene layer; false → scenes is empty. */
  hasScenes: boolean;
  scenes: SceneNode[];
  domains: SceneDomainNode[];
}

// ── search corpus ───────────────────────────────────────────────────────────

/** What kind of thing a search entry indexes. */
export type SearchEntryKind = "function" | "domain" | "module" | "spec";

/** One searchable record. The LLM search ranks over these. */
export interface SearchEntry {
  kind: SearchEntryKind;
  /** Stable ref: anchor id / domain name / module id / spec clause id. */
  ref: string;
  /** Display title (function/class/domain/module name, or spec heading). */
  title: string;
  /** Repo-relative file path (forward-slashed), when applicable. */
  file?: string;
  line?: number;
  /** Owning domain(s), when applicable. */
  domains?: string[];
  /** Owning module id, when applicable. */
  module?: string;
  /** Free text fed to the LLM (signature, spec text, description). */
  text?: string;
}

/** The prepared search corpus the LLM search runs against. */
export interface SearchCorpus {
  entries: SearchEntry[];
}

// ── full bundle (build.ts output, before persistence) ───────────────────────

/** Everything one prepare run produces, keyed by view name. */
export interface WebCacheBundle {
  graph: unknown;
  "domain-view": unknown;
  hotspots: unknown;
  "spec-links": unknown;
  domains: unknown;
  "scene-modules": SceneModulesPayload;
  "search-corpus": SearchCorpus;
}
