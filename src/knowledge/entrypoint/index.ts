export { materializeEntryPointGraph } from "./derive.js";
export type { MaterializeEntryPointInput } from "./derive.js";
export { buildEntryPointProjection } from "./projection.js";
export { syncCanonicalEntryPoints } from "./sync.js";
export type { EntryPointSyncRequest, EntryPointSyncResult } from "./sync.js";
export {
  computeEntryPointSourceRevision,
  entryPointKnowledgePaths,
  readProjectEntryPointInspection,
} from "./project-reader.js";
export type { EntryPointInspection, EntryPointKnowledgePaths } from "./project-reader.js";
export type { CanonicalEntryPointGraph, EntryPointGraphManifest } from "./types.js";
