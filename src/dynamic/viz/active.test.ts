import { describe, it, expect } from 'vitest';
import { buildActiveOverlay } from './active.js';
import type { CodeNode } from '../../types.js';

function node(id: string): CodeNode {
  return {
    id: id as CodeNode['id'],
    name: `fn_${id}`,
    kind: 'function',
    sourceRange: { filePath: 'a.cpp', start: { line: 1, column: 0 }, end: { line: 5, column: 0 } },
  };
}

describe('buildActiveOverlay', () => {
  it('returns all lit when every node is active', () => {
    const nodes = [node('aaa'), node('bbb')];
    const result = buildActiveOverlay(['aaa', 'bbb'], nodes);
    expect(result.litAnchors.sort()).toEqual(['aaa', 'bbb']);
    expect(result.dimAnchors).toHaveLength(0);
    expect(result.litCount).toBe(2);
    expect(result.totalCount).toBe(2);
  });

  it('returns all dim when no nodes are active', () => {
    const nodes = [node('aaa'), node('bbb')];
    const result = buildActiveOverlay([], nodes);
    expect(result.litAnchors).toHaveLength(0);
    expect(result.dimAnchors.sort()).toEqual(['aaa', 'bbb']);
    expect(result.litCount).toBe(0);
  });

  it('correctly splits lit and dim', () => {
    const nodes = [node('aaa'), node('bbb'), node('ccc')];
    const result = buildActiveOverlay(['aaa', 'ccc'], nodes);
    expect(result.litAnchors.sort()).toEqual(['aaa', 'ccc']);
    expect(result.dimAnchors).toEqual(['bbb']);
  });

  it('handles empty graph gracefully', () => {
    const result = buildActiveOverlay(['aaa'], []);
    expect(result.litAnchors).toHaveLength(0);
    expect(result.dimAnchors).toHaveLength(0);
    expect(result.totalCount).toBe(0);
  });

  it('ignores active zones not in the static graph', () => {
    const nodes = [node('known')];
    const result = buildActiveOverlay(['known', 'unknown-zone'], nodes);
    expect(result.litAnchors).toEqual(['known']);
    expect(result.totalCount).toBe(1);
  });
});