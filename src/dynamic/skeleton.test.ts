import { describe, it, expect } from 'vitest';
import type { AnchorId } from '../types.js';
import type { CodeNode, Edge } from '../types.js';
import type { CodeGraph } from '../graph/build.js';
import { InMemoryCodeGraph } from '../graph/in-memory.js';
import { extractLoopSkeleton } from './skeleton.js';

function makeNode(id: string, name: string): CodeNode {
  return {
    id: id as AnchorId,
    name,
    kind: 'function',
    sourceRange: {
      filePath: 'test.cpp',
      start: { line: 1, column: 0 },
      end: { line: 10, column: 0 },
    },
  };
}

function makeEdge(from: string, to: string): Edge {
  return { from: from as AnchorId, to: to as AnchorId, kind: 'calls' };
}

describe('extractLoopSkeleton', () => {
  it('includes root node at depth 0', async () => {
    const root = makeNode('root', 'GameLoop');
    const graph: CodeGraph = {
      nodes: new Map([['root' as AnchorId, root]]),
      adjacency: new Map([['root' as AnchorId, []]]),
      reverseAdjacency: new Map([['root' as AnchorId, []]]),
      edges: [],
    };
    const q = new InMemoryCodeGraph(graph);
    const result = await extractLoopSkeleton(q, 'root' as AnchorId);
    expect(result.rootAnchorId).toBe('root');
    expect(result.tickOrder).toHaveLength(1);
    expect(result.tickOrder[0]).toMatchObject({ anchorId: 'root', name: 'GameLoop', depth: 0 });
  });

  it('BFS order: root → A → B, then A→C', async () => {
    // Graph: root calls A and B, A calls C
    const nodes = new Map<AnchorId, CodeNode>([
      ['root' as AnchorId, makeNode('root', 'Root')],
      ['A' as AnchorId, makeNode('A', 'UpdateA')],
      ['B' as AnchorId, makeNode('B', 'UpdateB')],
      ['C' as AnchorId, makeNode('C', 'UpdateC')],
    ]);
    const eRA = makeEdge('root', 'A');
    const eRB = makeEdge('root', 'B');
    const eAC = makeEdge('A', 'C');
    const adjacency = new Map<AnchorId, Edge[]>([
      ['root' as AnchorId, [eRA, eRB]],
      ['A' as AnchorId, [eAC]],
      ['B' as AnchorId, []],
      ['C' as AnchorId, []],
    ]);
    const reverseAdjacency = new Map<AnchorId, Edge[]>([
      ['root' as AnchorId, []],
      ['A' as AnchorId, [eRA]],
      ['B' as AnchorId, [eRB]],
      ['C' as AnchorId, [eAC]],
    ]);
    const graph: CodeGraph = { nodes, adjacency, reverseAdjacency, edges: [eRA, eRB, eAC] };
    const q = new InMemoryCodeGraph(graph);
    const result = await extractLoopSkeleton(q, 'root' as AnchorId);

    const ids = result.tickOrder.map((e) => e.anchorId);
    expect(ids[0]).toBe('root');
    // BFS: root(0) -> A(1), B(1) -> C(2)
    expect(ids).toContain('A');
    expect(ids).toContain('B');
    expect(ids).toContain('C');
    // depths
    const byId = Object.fromEntries(result.tickOrder.map((e) => [e.anchorId, e.depth]));
    expect(byId['root']).toBe(0);
    expect(byId['A']).toBe(1);
    expect(byId['B']).toBe(1);
    expect(byId['C']).toBe(2);
  });

  it('deduplicates nodes that appear in multiple paths', async () => {
    // root -> A, root -> B, A -> C, B -> C (C reachable from both A and B)
    const nodes = new Map<AnchorId, CodeNode>([
      ['root' as AnchorId, makeNode('root', 'Root')],
      ['A' as AnchorId, makeNode('A', 'A')],
      ['B' as AnchorId, makeNode('B', 'B')],
      ['C' as AnchorId, makeNode('C', 'C')],
    ]);
    const eRA = makeEdge('root', 'A');
    const eRB = makeEdge('root', 'B');
    const eAC = makeEdge('A', 'C');
    const eBC = makeEdge('B', 'C');
    const adjacency = new Map<AnchorId, Edge[]>([
      ['root' as AnchorId, [eRA, eRB]],
      ['A' as AnchorId, [eAC]],
      ['B' as AnchorId, [eBC]],
      ['C' as AnchorId, []],
    ]);
    const reverseAdjacency = new Map<AnchorId, Edge[]>([
      ['root' as AnchorId, []],
      ['A' as AnchorId, [eRA]],
      ['B' as AnchorId, [eRB]],
      ['C' as AnchorId, [eAC, eBC]],
    ]);
    const graph: CodeGraph = { nodes, adjacency, reverseAdjacency, edges: [eRA, eRB, eAC, eBC] };
    const q = new InMemoryCodeGraph(graph);
    const result = await extractLoopSkeleton(q, 'root' as AnchorId);

    const ids = result.tickOrder.map((e) => e.anchorId);
    // C should appear exactly once
    expect(ids.filter((id) => id === 'C')).toHaveLength(1);
    expect(ids).toHaveLength(4);
  });

  it('respects maxDepth option', async () => {
    const nodes = new Map<AnchorId, CodeNode>([
      ['root' as AnchorId, makeNode('root', 'Root')],
      ['A' as AnchorId, makeNode('A', 'A')],
      ['B' as AnchorId, makeNode('B', 'B')],
    ]);
    const eRA = makeEdge('root', 'A');
    const eAB = makeEdge('A', 'B');
    const adjacency = new Map<AnchorId, Edge[]>([
      ['root' as AnchorId, [eRA]],
      ['A' as AnchorId, [eAB]],
      ['B' as AnchorId, []],
    ]);
    const reverseAdjacency = new Map<AnchorId, Edge[]>([
      ['root' as AnchorId, []],
      ['A' as AnchorId, [eRA]],
      ['B' as AnchorId, [eAB]],
    ]);
    const graph: CodeGraph = { nodes, adjacency, reverseAdjacency, edges: [eRA, eAB] };
    const q = new InMemoryCodeGraph(graph);
    const result = await extractLoopSkeleton(q, 'root' as AnchorId, { maxDepth: 1 });

    const ids = result.tickOrder.map((e) => e.anchorId);
    expect(ids).toContain('root');
    expect(ids).toContain('A');
    expect(ids).not.toContain('B');
  });
});
