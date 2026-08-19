/**
 * src/entrypoints/coloring.ts — Domain colouring for the entry graph.
 *
 * The entry graph is an axis of its own: it READS domain ownership and never
 * writes it (spec 不変条件 5). Business ownership comes from the knowledge log's
 * approved `domain-owns-code` edges when a state is supplied, else from the
 * analysis's semantic detection; program membership comes from
 * `program-domain-contains-code`. Both are resolved to anchors so the traversal
 * can colour nodes without knowing anything about the knowledge layer.
 *
 * SRP: colour lookup construction only.
 */

import type { AnalysisContext } from "../core.js";
import { semanticDetectionResults } from "../domains/detect.js";
import type { AnchorId } from "../types.js";
import type { KnowledgeGraph } from "../knowledge/types.js";
import type { EntryPointColoring } from "./types.js";

/** code-symbol entity id → anchor, from the code-symbol nodes' evidence. */
function anchorBySymbolId(state: KnowledgeGraph): Map<string, AnchorId> {
  const index = new Map<string, AnchorId>();
  for (const node of state.nodes.values()) {
    if (node.kind !== "code-symbol") continue;
    const anchor = node.data?.["anchorId"];
    if (typeof anchor === "string") index.set(node.id, anchor as AnchorId);
  }
  return index;
}

/** Lowest-sorted domain wins so the colouring is stable under re-analysis. */
function assignLowest(target: Map<AnchorId, string>, anchor: AnchorId, domainId: string): void {
  const current = target.get(anchor);
  if (current === undefined || domainId < current) target.set(anchor, domainId);
}

/** Build the anchor → (business, program) domain lookup. Reads only. */
export function buildColoring(ctx: AnalysisContext, state?: KnowledgeGraph): EntryPointColoring {
  const owner = new Map<AnchorId, string>();
  const programDomain = new Map<AnchorId, string>();

  if (state) {
    const anchors = anchorBySymbolId(state);
    for (const edge of [...state.edges.values()].sort((left, right) => left.id.localeCompare(right.id))) {
      const anchor = anchors.get(edge.to);
      if (!anchor) continue;
      if (edge.kind === "domain-owns-code") assignLowest(owner, anchor, edge.from);
      if (edge.kind === "program-domain-contains-code") assignLowest(programDomain, anchor, edge.from);
    }
  }

  if (owner.size === 0) {
    for (const result of semanticDetectionResults(ctx.domains ?? [])) {
      for (const anchor of result.implementors) assignLowest(owner, anchor, result.domain);
    }
  }
  return { owner, programDomain };
}
