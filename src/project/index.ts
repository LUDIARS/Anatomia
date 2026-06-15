/**
 * src/project/index.ts — Multi-project support barrel.
 */

export type { Project, ProjectInput, RegistrySnapshot } from "./types.js";
export { ProjectRegistry, slug, rootHash, deriveId } from "./registry.js";
export {
  resolveHome,
  registryPath,
  cacheRoot,
  saveRegistry,
  loadRegistry,
} from "./store.js";
export {
  AnalysisCache,
  computeFingerprint,
  merkleHashOf,
} from "./cache.js";
export type { CacheSnapshot, CacheEntry } from "./cache.js";
export { ProjectManager } from "./manager.js";
export type { ProjectManagerOptions } from "./manager.js";
