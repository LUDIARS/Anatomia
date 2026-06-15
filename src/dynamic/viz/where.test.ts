import { describe, it, expect } from 'vitest';
import { buildWhere } from './where.js';
import type { DomainCard } from '../../domains/card.js';
import type { AnchorId } from '../../types.js';

function card(domain: string, anchors: string[]): DomainCard {
  return {
    domain,
    summary: '',
    rules: [],
    keyAnchors: anchors as AnchorId[],
    specRefs: [],
    complexity: 'low',
    cacheKey: 'ck',
  };
}

describe('buildWhere', () => {
  it('returns null domain and anchor when no zones active', () => {
    const result = buildWhere(5, [], []);
    expect(result.frameId).toBe(5);
    expect(result.domain).toBeNull();
    expect(result.functionAnchorId).toBeNull();
    expect(result.phase).toBeNull();
    expect(result.label).toContain('frame 5');
  });

  it('finds domain from innermost (last) anchor', () => {
    const cards = [
      card('Physics', ['anchor-physics']),
      card('Render', ['anchor-render']),
    ];
    const result = buildWhere(10, ['anchor-physics', 'anchor-render'], cards);
    expect(result.domain).toBe('Render');
    expect(result.functionAnchorId).toBe('anchor-render');
  });

  it('label has correct format', () => {
    const cards = [card('Combat', ['abc123def456'])];
    const result = buildWhere(3, ['abc123def456'], cards);
    expect(result.label).toBe('frame 3 -> domain=Combat / function=abc123def456');
  });

  it('phase is always null (SS5.5 deferred)', () => {
    const result = buildWhere(1, ['x'], []);
    expect(result.phase).toBeNull();
  });

  it('function part truncated to 12 chars in label when longer', () => {
    const longAnchor = 'abcdefghijklmnop'; // 16 chars
    const result = buildWhere(1, [longAnchor], []);
    expect(result.label).toContain('function=abcdefghijkl');
  });

  it('domain=? when anchor not found in any card', () => {
    const result = buildWhere(1, ['unknown-anchor'], []);
    expect(result.domain).toBeNull();
    expect(result.label).toContain('domain=?');
  });
});