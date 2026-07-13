import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AnalysisContext } from '../core.js';
import type { AnchorId, AstNode, FunctionNode } from '../types.js';
import { buildFocusedTestingFacts, FocusedTestingError } from './focused-testing.js';

const playerAnchor = 'player-anchor' as AnchorId;
const repoPath = join('C:\\repo');
const filePath = join(repoPath, 'src', 'player.cpp');

const playerFunction: FunctionNode = {
  id: playerAnchor,
  name: 'PlayerController::applyInput',
  signature: 'void PlayerController::applyInput(InputFrame input)',
  enclosingType: 'PlayerController',
  params: [{ name: 'input', type: 'InputFrame' }],
  sourceRange: {
    filePath,
    start: { line: 42, column: 1 },
    end: { line: 60, column: 1 },
  },
  bodyAst: {} as AstNode,
};

const context = {
  repoPath,
  graph: {},
  files: [{
    path: filePath,
    hash: null,
    functions: [playerFunction],
    types: [{
      name: 'PlayerController',
      bases: [],
      filePath,
      fields: [{ name: 'health', type: null }],
    }],
  }],
  functions: [playerFunction],
  domains: [{ domain: 'player-actions', implementors: [playerAnchor], violations: [], conforms: true }],
} as unknown as AnalysisContext;

describe('buildFocusedTestingFacts', () => {
  it('maps domain implementors and important variables into stable Augur facts', () => {
    const facts = buildFocusedTestingFacts(context, [{
      domain: 'player-actions',
      priority: 'high',
      risks: ['boundary', 'memory_safety'],
      variables: [
        { pattern: 'input', priority: 'critical' },
        { pattern: 'health', priority: 'high' },
      ],
      rationale: 'Player-controlled state is authoritative.',
    }]);

    expect(facts).toEqual({
      source: 'anatomia',
      domains: [{
        domain: 'player-actions',
        priority: 'high',
        risks: ['boundary', 'memory_safety'],
        rationale: 'Player-controlled state is authoritative.',
        targets: [{
          symbol: 'PlayerController::applyInput',
          file: 'src/player.cpp',
          line: 42,
          variables: [
            { name: 'health', kind: 'field', priority: 'high' },
            { name: 'input', kind: 'parameter', priority: 'critical', type: 'InputFrame' },
          ],
        }],
      }],
    });
  });

  it('rejects a variable policy that matches no analyzed variable', () => {
    expect(() => buildFocusedTestingFacts(context, [{
      domain: 'player-actions',
      priority: 'critical',
      risks: ['boundary'],
      variables: [{ pattern: 'npcOnly', priority: 'low' }],
    }])).toThrow(FocusedTestingError);
  });

  it('infers risk kinds mechanically when the caller only sets priority', () => {
    const facts = buildFocusedTestingFacts(context, [{
      domain: 'player-actions',
      priority: 'critical',
      risks: [],
      variables: [{ pattern: 'input', priority: 'critical' }],
    }]);
    expect(facts.domains[0]?.risks).toEqual([
      'boundary',
      'memory_safety',
      'authorization',
      'state_transition',
      'contract',
    ]);
    expect(facts.domains[0]?.inferredRisks).toEqual(facts.domains[0]?.risks);
  });
});
