/**
 * src/entrypoints/index.ts — Public surface of the entry-point layer.
 */

export { buildEntryPointManifest, detectEntryPoints, foldSeeds } from "./detect.js";
export type { DetectEntryPointsOptions } from "./detect.js";
export { deriveEntryPointGraph } from "./derive.js";
export type { DeriveEntryPointGraphInput } from "./derive.js";
export { buildColoring } from "./coloring.js";
export { entryPointGraphFor, nearestEntriesFor } from "./context.js";
export {
  defaultEntryPointConfig,
  computeEntryPointConfigRevision,
  isTestPath,
  loadEntryPointConfig,
  normalizeEntryPointConfig,
  ruleMatches,
} from "./config.js";
export { DETECTORS } from "./detectors/index.js";
export type { Detector, DetectorInput, PackageManifest } from "./detectors/index.js";
export { SymbolIndex } from "./symbols.js";
export type { IndexedSymbol } from "./symbols.js";
export * from "./types.js";
