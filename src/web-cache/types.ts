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
import type { AccessPattern } from "../patterns/detect.js";
import type { RefactoringProposal } from "../review/refactoring-proposals.js";

/** The set of views the prepare step builds + the panel renders from cache. */
export type WebViewName =
  | "graph"
  | "domain-view"
  | "business-domain-view"
  | "program-domain-view"
  | "scene-view"
  | "access-patterns"
  | "hotspots"
  | "spec-links"
  | "domains"
  | "scene-modules"
  | "search-corpus";

/** All view names, in render order (also the prepare build order). */
export const WEB_VIEWS: readonly WebViewName[] = [
  "graph",
  "domain-view",
  "business-domain-view",
  "program-domain-view",
  "scene-view",
  "access-patterns",
  "hotspots",
  "spec-links",
  "domains",
  "scene-modules",
  "search-corpus",
] as const;

/** Analyzer-output schema shared by the prepared manifest and every view. */
export const WEB_CACHE_SCHEMA_VERSION = 4 as const;

/**
 * One prepared view, on disk as <view>.json. Carries its own generation date so
 * every view independently answers "when was this built" — the panel stamps each
 * tab with it.
 */
export interface WebViewEnvelope<T = unknown> {
  version: typeof WEB_CACHE_SCHEMA_VERSION;
  view: WebViewName;
  /** ISO generation date of THIS view. */
  preparedAt: string;
  /** Source fingerprint at prepare time (for the panel's stale indicator). */
  fingerprint: string;
  data: T;
}

/** The manifest written alongside the view files (the index of a prepared cache). */
export interface WebCacheManifest {
  version: typeof WEB_CACHE_SCHEMA_VERSION;
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

/** A domain slice inside a scene, with the modules that implement that slice. */
export interface SceneDomainSlice {
  domain: string;
  conforms: boolean;
  violationCount: number;
  modules: SceneModuleNode[];
}

/** A scene node: a runtime phase, UI screen, or cross-screen workflow/module. */
export interface SceneNode {
  id: string;
  label?: string;
  /** Domain names active in this scene. Empty is valid for a scene not yet mapped. */
  domains: string[];
  /** Domain/module details for the scene's active domains. */
  domainSlices: SceneDomainSlice[];
}

/**
 * The Scenes view: scene → domain slice → module. Domains are supporting detail;
 * the display contract is scene-centred.
 */
export interface SceneModulesPayload {
  /** True when manual or discovered scenes exist; false → scenes is empty. */
  hasScenes: boolean;
  scenes: SceneNode[];
}

/** Scene-tab payload, entirely assembled during web-cache preparation. */
export interface SceneViewPayload {
  scenes: SceneViewScene[];
}

export interface SceneViewScene {
  id: string;
  label: string;
  kind: string;
  stack: string | null;
  fidelity: "capture" | "wireframe" | "tree";
  captureUrl: string | null;
  wireframe: { nodes: Array<{ id: string; label: string; kind: string }>; transitions: string[] } | null;
  elements: Array<{ id: string; label: string }>;
  businessDomainIds: string[];
  programDomainIds: string[];
  transitionSceneIds: string[];
}

/** Read-only business-domain inspection, assembled during web-cache preparation. */
export interface BusinessDomainViewPayload {
  domains: BusinessDomainViewDomain[];
  /** Program-domain code which is intentionally not owned by a business domain. */
  unlinkedProgramDomains: Array<{
    programDomainId: string;
    codeSymbolCount: number;
    codeSymbols: Array<{ id: string; file: string; line: number | null }>;
  }>;
}

export interface BusinessDomainViewDomain {
  id: string;
  name: string;
  purpose: string;
  boundary: { inScope: string[]; outOfScope: string[] };
  status: "implemented" | "spec-only" | "missing";
  parentId: string | null;
  childIds: string[];
  specRefs: Array<{ id: string; heading: string; excerpt: string; file: string; line: number | null }>;
  programDomains: Array<{
    programDomainId: string;
    weight: number;
    codeSymbols: Array<{ id: string; file: string; line: number | null }>;
  }>;
  relatedSceneIds: string[];
}

export interface ProgramDomainModuleDependency {
  fromModuleId: string;
  toModuleId: string;
  weight: number;
}

export interface ProgramDomainViewDomain {
  id: string;
  layer: string;
  moduleIds: string[];
  codeSymbolIds: string[];
  cohesion: number | null;
  modularity: number;
  misfitCount: number;
  modules: Array<{ moduleId: string; cohesion: number | null; misfitCount: number }>;
  /** Intra-domain module dependencies for the domain detail drill-down. */
  moduleDependencies: ProgramDomainModuleDependency[];
  businessDomains: Array<{ businessDomainId: string; weight: number; evidence: { codeSymbols: Array<{ id: string; file: string; line: number | null }>; specClauses: Array<{ id: string; file: string; line: number | null }> } }>;
  unlinkedCodeSymbolCount: number;
  unlinkedCodeSymbols: Array<{ id: string; file: string; line: number | null }>;
}

/** Read-only program-domain inspection, precomputed with the web cache. */
export interface ProgramDomainViewPayload {
  layers: Array<{ layer: string; domains: ProgramDomainViewDomain[] }>;
  diagnostics: Array<{ kind: "unclassified"; moduleId: string; symbolIds: string[]; reason: "no-layer-rule" }>;
  classDiagram: { nodes: unknown[]; edges: unknown[] };
  dependencies: Array<{ from: string; to: string; weight: number; layerViolation: boolean; modules: ProgramDomainModuleDependency[] }>;
  modularity: number;
  /** Active deterministic findings. Resolved signals are absent after the next prepare. */
  proposals: RefactoringProposal[];
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
  "business-domain-view": BusinessDomainViewPayload;
  "program-domain-view": ProgramDomainViewPayload;
  "scene-view": SceneViewPayload;
  "access-patterns": AccessPattern[];
  hotspots: unknown;
  "spec-links": unknown;
  domains: unknown;
  "scene-modules": SceneModulesPayload;
  "search-corpus": SearchCorpus;
}
