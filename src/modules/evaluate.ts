/**
 * src/modules/evaluate.ts — Evaluate modules straight from a code graph.
 *
 * Convenience wiring: collect the graph's edges once, build the partition, and
 * score it. Used by the analyze-time domain-view artifact and integral search.
 *
 * SRP: graph → ModuleEvaluation glue only.
 */

import type { AnchorId, Edge, FunctionNode } from "../types.js";
import type { CodeGraphQuery } from "../graph/query.js";
import { buildModules, moduleIndex } from "./build.js";
import { evaluateModules } from "./cohesion.js";
import type { ModuleEvaluation, ModuleGranularity, ModuleUnit } from "./types.js";

/** Collect every edge in a graph (one pass over nodes' outgoing edges). */
export async function collectEdges(graph: CodeGraphQuery): Promise<Edge[]> {
  const nodes = await graph.allNodes();
  const edges: Edge[] = [];
  for (const n of nodes) edges.push(...(await graph.edgesFrom(n.id)));
  return edges;
}

/** Build + evaluate the module partition for a graph. */
export async function evaluateModulesFromGraph(
  graph: CodeGraphQuery,
  functions: FunctionNode[],
  granularity: ModuleGranularity = "dir",
): Promise<{ evaluation: ModuleEvaluation; index: Map<AnchorId, string>; modules: ModuleUnit[] }> {
  const modules = buildModules(functions, granularity);
  const index = moduleIndex(modules);
  const edges = await collectEdges(graph);
  const nodeById = new Map((await graph.allNodes()).map((n) => [n.id, n.name]));
  const nameOf = (a: AnchorId): string => nodeById.get(a) ?? "<unknown>";
  const evaluation = evaluateModules(modules, edges, index, nameOf, granularity);
  return { evaluation, index, modules };
}
