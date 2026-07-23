import { describe, expect, it } from 'vitest';
import { FocusedTestingError } from '../../../domains/focused-testing.js';
import { parseFocusedTestingInput } from './focused-testing-input.js';

describe('parseFocusedTestingInput', () => {
  it('validates and normalizes caller-defined focus policies', () => {
    expect(parseFocusedTestingInput({
      domains: [{
        domain: 'player-actions',
        priority: 'critical',
        risks: ['boundary', 'boundary', 'memory_safety'],
        variables: [{ pattern: ' input ', priority: 'critical' }],
      }],
    })).toEqual([{
      domain: 'player-actions',
      priority: 'critical',
      risks: ['boundary', 'memory_safety'],
      variables: [{ pattern: 'input', priority: 'critical' }],
    }]);
  });

  it('rejects duplicate domains at the trust boundary', () => {
    expect(() => parseFocusedTestingInput({
      domains: [
        { domain: 'player-actions', priority: 'high', risks: ['boundary'] },
        { domain: 'player-actions', priority: 'low', risks: ['contract'] },
      ],
    })).toThrow(FocusedTestingError);
  });
});
