/**
 * graph/ — Code graph + KG layer (G2).
 *
 * Pipeline:
 *   buildGraph (T11) — FileNode[] → CodeGraph (in-memory)
 *   InMemoryCodeGraph (T12) — CodeGraph → CodeGraphQuery (in-memory impl)
 *   KuzuCodeGraph (T13) — CodeGraph → CodeGraphQuery (Kuzu-backed impl)
 *
 * Downstream consumers depend on CodeGraphQuery; storage is swappable.
 */

export { buildGraph, extractEdgeInfo, extractFunctionEdgeInfo } from "./build.js";
export type { CodeGraph, FunctionEdgeInfo } from "./build.js";

export type { CodeGraphQuery, EdgeFilter, FanCounts, TraversalOptions } from "./query.js";

export { InMemoryCodeGraph } from "./in-memory.js";
export { KuzuCodeGraph } from "./kuzu.js";
export { buildSymbolIndex, findSymbol, callersOf, calleesOf } from "./symbol-lookup.js";
export type { SymbolHit, SymbolLookupOptions } from "./symbol-lookup.js";
