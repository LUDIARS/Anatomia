/**
 * T41 -- Active overlay shaper.
 * buildActiveOverlay(activeZoneSet, graphNodes) -> ActiveOverlay
 */
import type { CodeNode } from '../../types.js';

export interface ActiveOverlay {
  /** Anchor IDs (graph node IDs) currently executing (lit). */
  litAnchors: string[];
  /** Anchor IDs (graph node IDs) not currently executing (dim). */
  dimAnchors: string[];
  litCount: number;
  totalCount: number;
}

/**
 * Mark which static graph nodes are currently active.
 *
 * @param activeZoneSet  Raw anchor IDs active in the current frame
 *                       (from TraceSource.currentActiveZoneSet()).
 * @param graphNodes     All CodeNode entries from the static graph.
 */
export function buildActiveOverlay(
  activeZoneSet: string[],
  graphNodes: CodeNode[],
): ActiveOverlay {
  const activeSet = new Set(activeZoneSet);
  const litAnchors: string[] = [];
  const dimAnchors: string[] = [];

  for (const node of graphNodes) {
    if (activeSet.has(node.id)) {
      litAnchors.push(node.id);
    } else {
      dimAnchors.push(node.id);
    }
  }

  return {
    litAnchors,
    dimAnchors,
    litCount: litAnchors.length,
    totalCount: graphNodes.length,
  };
}