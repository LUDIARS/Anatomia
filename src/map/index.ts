/**
 * src/map/ — Cross-project domain map (design §12).
 *
 *   types.ts            record / project-map / hit shapes
 *   aliases.ts          spelling normalisation + tokenisation
 *   content-sources.ts  `spec/domains/content-sources.json` + the spec H1 fallback
 *   project-codes.ts    LUDIARS roster (Concordia), for cross-project links
 *   links.ts            spec text → cross-project + service links
 *   sources.ts          one repo → its records
 *   inverted-index.ts   records → the searchable index
 *   search.ts           free-text instruction → ranked hits
 *   bundle.ts           every registered project, refreshed on source change
 *   format.ts           hit lines + `map show` rendering
 */
// @implements SPEC-domain-map

export { aliasKeys, indexTokens, katakanaToHiragana, normalizeAlias, pathTokens, queryTokens } from "./aliases.js";
export {
  CONTENT_SOURCES_REL,
  collectContentEntries,
  collectContentSourceFiles,
  frontmatterTitleOf,
  globToRegExp,
  headingOf,
  loadContentSources,
} from "./content-sources.js";
export type { ContentEntry, ContentNameSource, ContentSourceRule } from "./content-sources.js";
export { extractLinks, httpSurfaces } from "./links.js";
export {
  PROJECT_CODES_PATH,
  fetchProjectCodes,
  parseProjectCodes,
  projectCodesKey,
  resolveProjectCodesUrl,
} from "./project-codes.js";
export type { ProjectCode, ProjectCodesOptions } from "./project-codes.js";
export {
  buildProjectDomainMap,
  computeMapSourceKey,
  layersForPaths,
  pathHintFromPattern,
} from "./sources.js";
export type { BuildProjectMapOptions, MapProjectInput } from "./sources.js";
export { addProjectToIndex, buildDomainMapIndex } from "./inverted-index.js";
export type { DomainMapIndex, Posting } from "./inverted-index.js";
export { DEFAULT_SEARCH_LIMIT, searchDomainMap } from "./search.js";
export type { SearchDomainMapOptions } from "./search.js";
export {
  clearDomainMapMemo,
  loadDomainMapBundle,
  loadProjectDomainMap,
  sourcesFromRegistry,
} from "./bundle.js";
export type {
  DomainMapBundle,
  LoadBundleOptions,
  MapProjectSource,
  RegistryLike,
} from "./bundle.js";
export { NO_HIT_MESSAGE, formatProjectMap, formatSearchHits, hitLine } from "./format.js";
export { DOMAIN_MAP_VERSION } from "./types.js";
export type {
  DomainMapHit,
  DomainMapKind,
  DomainMapLink,
  DomainMapRecord,
  ProjectDomainMap,
} from "./types.js";
