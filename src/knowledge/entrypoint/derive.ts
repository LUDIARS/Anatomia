/**
 * src/knowledge/entrypoint/derive.ts — Entry graph → knowledge records.
 *
 * Only the ENTRY itself becomes a knowledge node: the reached set is a per-entry
 * fact of one analysis and belongs in the artifact, not in a log that would grow
 * by tens of thousands of edges on every sync. The node keeps the summary
 * numbers (reached / maxDistance / frontierCount) so a query answers "how much
 * of the product does this entry cover" without loading the artifact.
 *
 * Domain edges are emitted only for domains that ALREADY EXIST in the knowledge
 * state: a heuristic domain name is not an entity, and emitting an edge to an
 * id the log does not hold would either dangle (the log rejects it) or force
 * this feature to create domain nodes — a write into the layer it is required
 * to only read.
 *
 * SRP: record materialization only.
 */

import { describeCodeSymbol } from "../code-symbol.js";
import { entryPointEntityId } from "../identity.js";
import type { KnowledgeEdge, KnowledgeNode } from "../types.js";
import type { FunctionNode } from "../../types.js";
import type { EntryPointGraph } from "../../entrypoints/types.js";
import type { CanonicalEntryPointGraph } from "./types.js";

export interface MaterializeEntryPointInput {
  graph: EntryPointGraph;
  projectRoot: string;
  /** Anchored functions of the analysis, used to describe entry code symbols. */
  functions: readonly FunctionNode[];
  /**
   * Domain entity ids the knowledge state already holds. Only these become
   * `entry-point-activates-domain` edges. Omitted → no domain edges.
   */
  knownDomainIds?: ReadonlySet<string>;
}

function edge(
  owner: string,
  kind: KnowledgeEdge["kind"],
  from: string,
  to: string,
  evidence: Record<string, unknown> = {},
): KnowledgeEdge {
  return { id: `${kind}:${from}->${to}`, kind, from, to, evidence: { ...evidence, derivedOwner: owner } };
}

/** Build the canonical record set for one derived entry graph. */
export function materializeEntryPointGraph(
  input: MaterializeEntryPointInput,
): CanonicalEntryPointGraph {
  const { graph } = input;
  const owner = `entry-point:${graph.projectId}`;
  const byAnchor = new Map(input.functions.filter((fn) => fn.id).map((fn) => [String(fn.id), fn]));
  const nodes: KnowledgeNode[] = [];
  const edges: KnowledgeEdge[] = [];

  for (const entry of graph.entries) {
    const entryId = entryPointEntityId(graph.projectId, String(entry.symbol.anchor));
    nodes.push({
      id: entryId,
      kind: "entry-point",
      revision: {
        sourceRevision: graph.sourceRevision,
        contentFingerprint: `anchor:${String(entry.symbol.anchor)}`,
        sourcePath: entry.symbol.path,
        sourceRange: { startLine: entry.symbol.line, endLine: entry.symbol.line },
      },
      data: {
        derivedOwner: owner,
        anchorId: String(entry.symbol.anchor),
        name: entry.symbol.name,
        path: entry.symbol.path,
        classes: entry.classes,
        detector: entry.detector,
        ...(entry.phase ? { phase: entry.phase } : {}),
        reached: entry.reached,
        maxDistance: entry.maxDistance,
        frontierCount: entry.frontierCount,
      },
    });

    const fn = byAnchor.get(String(entry.symbol.anchor));
    if (fn) {
      const evidence = describeCodeSymbol(graph.projectId, input.projectRoot, fn, graph.sourceRevision);
      nodes.push({
        id: evidence.symbolId,
        kind: "code-symbol",
        revision: {
          sourceRevision: graph.sourceRevision,
          contentFingerprint: evidence.contentFingerprint,
          sourcePath: evidence.sourcePath,
          sourceRange: { startLine: evidence.startLine, endLine: evidence.endLine },
        },
        data: { ...evidence, derivedOwner: owner },
      });
      edges.push(edge(owner, "entry-point-has-symbol", entryId, evidence.symbolId, {
        classes: entry.classes,
      }));
    }

    for (const domainId of entry.activatesDomains.business) {
      if (!input.knownDomainIds?.has(domainId)) continue;
      edges.push(edge(owner, "entry-point-activates-domain", entryId, domainId));
    }
  }

  return {
    projectId: graph.projectId,
    sourceRevision: graph.sourceRevision,
    definitionFingerprint: graph.definitionFingerprint,
    graph,
    nodes: nodes.sort((left, right) => left.id.localeCompare(right.id)),
    edges: edges.sort((left, right) => left.id.localeCompare(right.id)),
  };
}
