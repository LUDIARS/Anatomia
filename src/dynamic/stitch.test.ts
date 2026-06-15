import { describe, it, expect } from 'vitest';
import type { AnchorId } from '../types.js';
import type { DecodedFrame } from './protocol.js';
import type { DomainCard } from '../domains/card.js';
import { stitchFrame } from './stitch.js';

function makeCard(domain: string, anchors: string[]): DomainCard {
  return {
    domain,
    summary: `${domain} summary`,
    rules: [],
    keyAnchors: anchors as AnchorId[],
    specRefs: [],
    complexity: 'medium',
    cacheKey: domain,
  };
}

describe('stitchFrame', () => {
  it('correctly identifies active domains', () => {
    const frame: DecodedFrame = {
      frameId: 1,
      frameBeginUs: 0,
      frameEndUs: 1000,
      activeZoneSet: ['anchor-movement', 'anchor-combat'],
      zoneTimes: { 'anchor-movement': 300, 'anchor-combat': 500 },
    };
    const cards: DomainCard[] = [
      makeCard('Movement', ['anchor-movement']),
      makeCard('Combat', ['anchor-combat']),
    ];

    const result = stitchFrame(frame, cards);
    expect(result.activeDomains).toContain('Movement');
    expect(result.activeDomains).toContain('Combat');
  });

  it('preserves first-seen order of activeDomains', () => {
    const frame: DecodedFrame = {
      frameId: 1,
      frameBeginUs: 0,
      frameEndUs: 1000,
      activeZoneSet: ['anchor-movement', 'anchor-combat'],
      zoneTimes: { 'anchor-movement': 300, 'anchor-combat': 500 },
    };
    const cards: DomainCard[] = [
      makeCard('Movement', ['anchor-movement']),
      makeCard('Combat', ['anchor-combat']),
    ];

    const result = stitchFrame(frame, cards);
    // Movement should come before Combat (first seen)
    expect(result.activeDomains[0]).toBe('Movement');
    expect(result.activeDomains[1]).toBe('Combat');
  });

  it('deduplicates domains when multiple anchors belong to same domain', () => {
    const frame: DecodedFrame = {
      frameId: 1,
      frameBeginUs: 0,
      frameEndUs: 1000,
      activeZoneSet: ['anchor-a1', 'anchor-a2'],
      zoneTimes: { 'anchor-a1': 200, 'anchor-a2': 100 },
    };
    const cards: DomainCard[] = [
      makeCard('Movement', ['anchor-a1', 'anchor-a2']),
    ];

    const result = stitchFrame(frame, cards);
    expect(result.activeDomains).toHaveLength(1);
    expect(result.activeDomains[0]).toBe('Movement');
  });

  it('accumulates domain times from multiple anchors', () => {
    const frame: DecodedFrame = {
      frameId: 1,
      frameBeginUs: 0,
      frameEndUs: 1000,
      activeZoneSet: ['anchor-a1', 'anchor-a2'],
      zoneTimes: { 'anchor-a1': 200, 'anchor-a2': 150 },
    };
    const cards: DomainCard[] = [
      makeCard('Movement', ['anchor-a1', 'anchor-a2']),
    ];

    const result = stitchFrame(frame, cards);
    expect(result.domainTimes['Movement']).toBe(350);
  });

  it('hotZone points to anchor with max zone time', () => {
    const frame: DecodedFrame = {
      frameId: 1,
      frameBeginUs: 0,
      frameEndUs: 1000,
      activeZoneSet: ['anchor-movement', 'anchor-combat'],
      zoneTimes: { 'anchor-movement': 300, 'anchor-combat': 700 },
    };
    const cards: DomainCard[] = [
      makeCard('Movement', ['anchor-movement']),
      makeCard('Combat', ['anchor-combat']),
    ];

    const result = stitchFrame(frame, cards);
    expect(result.hotZone).not.toBeNull();
    expect(result.hotZone!.anchorId).toBe('anchor-combat');
    expect(result.hotZone!.domain).toBe('Combat');
    expect(result.hotZone!.accumulatedUs).toBe(700);
  });

  it('hotZone is null when no active zones', () => {
    const frame: DecodedFrame = {
      frameId: 1,
      frameBeginUs: 0,
      frameEndUs: 100,
      activeZoneSet: [],
      zoneTimes: {},
    };
    const result = stitchFrame(frame, []);
    expect(result.hotZone).toBeNull();
  });

  it('ignores anchors that do not match any card', () => {
    const frame: DecodedFrame = {
      frameId: 1,
      frameBeginUs: 0,
      frameEndUs: 500,
      activeZoneSet: ['unknown-anchor'],
      zoneTimes: { 'unknown-anchor': 100 },
    };
    const result = stitchFrame(frame, []);
    expect(result.activeDomains).toHaveLength(0);
    expect(result.domainTimes).toEqual({});
    // hotZone still picks the max-time anchor even without a card match
    expect(result.hotZone).not.toBeNull();
    expect(result.hotZone!.anchorId).toBe('unknown-anchor');
    expect(result.hotZone!.domain).toBe('');
  });
});
