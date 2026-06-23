/**
 * src/domains/retune/index.ts — Public surface of the domain re-tune subsystem.
 *
 * SRP: re-export only.
 */

export * from "./types.js";
export { runRetune, runRetuneOnContext } from "./pipeline.js";
export type { RetuneOptions } from "./pipeline.js";
export { summarizeNodes, classifyBySize, dirStats, nodeSize, percentile } from "./graph-stats.js";
export {
  taxonomyToDomainDefs,
  domainPlanToDef,
  moduleResolver,
  assignNodeToModule,
  unassignedNodes,
} from "./grouping.js";
export { registerTaxonomy, renderTaxonomyMd, ONTOLOGY_DIR_REL } from "./register.js";
export { loadState, saveState, recordPass, shouldHaltForHuman, HALT_AFTER_ITERATIONS } from "./state.js";
export { extractJson, stripFence, callLlmJson, asArray } from "./llm.js";
export { loadTaxonomyResolver } from "./load-taxonomy.js";
export type { ModuleResolver } from "./load-taxonomy.js";
