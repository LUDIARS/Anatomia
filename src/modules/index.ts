/**
 * src/modules/index.ts — The 機能(module) layer public surface.
 *
 * Module = a deterministic structural cohesion unit between function and domain.
 * Built by directory/class, evaluated by cohesion/coupling/misfit/modularity,
 * never auto-reclustered.
 */

export type {
  ModuleGranularity,
  ModuleUnit,
  ModuleCohesion,
  MisfitFunction,
  ModuleEvaluation,
} from "./types.js";
export { buildModules, moduleIndex } from "./build.js";
export {
  moduleCohesion,
  misfitFunctions,
  modularity,
  evaluateModules,
} from "./cohesion.js";
export { collectEdges, evaluateModulesFromGraph } from "./evaluate.js";
