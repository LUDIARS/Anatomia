/**
 * T33 — Static loop skeleton extractor.
 * BFS following "calls" edges from a root anchor to derive ordered system-tick sequence.
 */
import type { AnchorId } from '../types.js';
import type { CodeGraphQuery } from '../graph/query.js';

export interface TickEntry {
  anchorId: AnchorId;
  name: string;
  depth: number;
}

export interface LoopSkeleton {
  rootAnchorId: AnchorId;
  tickOrder: TickEntry[];
}

export async function extractLoopSkeleton(
  graph: CodeGraphQuery,
  rootAnchorId: AnchorId,
  options?: { maxDepth?: number },
): Promise<LoopSkeleton> {
  const maxDepth = options?.maxDepth ?? Infinity;
  const visited = new Set<AnchorId>();
  const tickOrder: TickEntry[] = [];

  // BFS queue: [anchorId, depth]
  const queue: Array<{ id: AnchorId; depth: number }> = [{ id: rootAnchorId, depth: 0 }];
  visited.add(rootAnchorId);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const node = await graph.getNode(current.id);
    const name = node ? node.name : current.id;

    tickOrder.push({ anchorId: current.id, name, depth: current.depth });

    if (current.depth >= maxDepth) continue;

    const outNeighbors = await graph.neighbors(current.id, 'calls');
    for (const neighbor of outNeighbors) {
      if (visited.has(neighbor.id)) continue;
      visited.add(neighbor.id);
      queue.push({ id: neighbor.id, depth: current.depth + 1 });
    }
  }

  return { rootAnchorId, tickOrder };
}
