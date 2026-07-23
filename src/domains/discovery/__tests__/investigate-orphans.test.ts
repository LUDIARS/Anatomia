import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnalysisContext } from '../../../core.js';
import { evaluateModulesFromGraph } from '../../../modules/index.js';
import type { AnchorId, FunctionNode } from '../../../types.js';
import { investigateOrphanFunctions } from '../investigate-orphans.js';

vi.mock('../../../modules/index.js', () => ({
  evaluateModulesFromGraph: vi.fn(),
}));

interface ModuleFixture {
  readonly id: string;
  readonly label: string;
  readonly anchors: readonly string[];
  readonly cohesion?: number;
}

describe('investigateOrphanFunctions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('excludes assigned implementors and reports repository-relative one-based locations', async () => {
    const assigned = functionNode('assigned', 'C:\\repo\\src\\assigned.ts', 0, 0);
    const orphan = functionNode('orphan', 'C:\\repo\\src\\orphan.ts', 1, 3);
    orphan.enclosingType = 'Worker';
    orphan.signatureShape = '(sig (scope Worker) (name orphan) (ret ))';
    arrangeModules([
      { id: 'src', label: 'src', anchors: ['orphan'], cohesion: 0.75 },
    ]);
    const context = analysisContext([assigned, orphan], ['assigned']);

    const result = await investigateOrphanFunctions(context);

    expect(result.functions).toEqual([
      {
        anchor: 'orphan',
        name: 'orphan',
        signature: 'orphan()',
        signatureShape: '(sig (scope Worker) (name orphan) (ret ))',
        enclosingType: 'Worker',
        reason: 'unassigned-domain',
        file: 'src/orphan.ts',
        line: 2,
        endLine: 4,
      },
    ]);
    expect(evaluateModulesFromGraph).toHaveBeenCalledOnce();
    const [, evaluatedFunctions, granularity] = vi.mocked(evaluateModulesFromGraph).mock.calls[0]!;
    expect(evaluatedFunctions.map((item) => item.id)).toEqual(['orphan']);
    expect(granularity).toBe('dir');
  });

  it('proposes only sufficiently large groups and leaves singleton functions remaining', async () => {
    const functions = [
      functionNode('charlie', 'C:\\repo\\large\\charlie.ts'),
      functionNode('alpha', 'C:\\repo\\large\\alpha.ts'),
      functionNode('bravo', 'C:\\repo\\large\\bravo.ts'),
      functionNode('solo', 'C:\\repo\\small\\solo.ts'),
    ];
    arrangeModules([
      { id: 'small', label: 'small', anchors: ['solo'], cohesion: 0 },
      {
        id: 'large',
        label: 'large',
        anchors: ['charlie', 'bravo', 'alpha'],
        cohesion: 0.8,
      },
    ]);

    const result = await investigateOrphanFunctions(analysisContext(functions));

    expect(result.groups).toHaveLength(2);
    expect(result.candidateGroups).toHaveLength(1);
    expect(result.candidateGroups[0]).toMatchObject({
      label: 'large',
      size: 3,
      functionCount: 3,
      cohesion: 0.8,
    });
    expect(result.candidateGroups[0]!.functions.map((item) => item.anchor)).toEqual([
      'alpha',
      'bravo',
      'charlie',
    ]);
    expect(result.remainingFunctions.map((item) => item.anchor)).toEqual(['solo']);
  });

  it('fails fast instead of silently omitting functions without Anchor IDs', async () => {
    const unanchored = functionNode('pending', 'C:\\repo\\src\\pending.ts', 4, 6);
    unanchored.id = null;

    await expect(investigateOrphanFunctions(analysisContext([unanchored]))).rejects.toThrow(
      /missing 1: src\/pending\.ts:5 pending/,
    );
    expect(evaluateModulesFromGraph).not.toHaveBeenCalled();
  });

  it('keeps ordering and SHA-256 identifiers stable across input and module order', async () => {
    const alpha = functionNode('alpha', 'C:\\repo\\a\\alpha.ts');
    const zulu = functionNode('zulu', 'C:\\repo\\z\\zulu.ts');
    arrangeModules([
      { id: 'z', label: 'z', anchors: ['zulu'] },
      { id: 'a', label: 'a', anchors: ['alpha'] },
    ]);

    const first = await investigateOrphanFunctions(analysisContext([zulu, alpha]), {
      minGroupFunctions: 1,
    });

    arrangeModules([
      { id: 'a', label: 'a', anchors: ['alpha'] },
      { id: 'z', label: 'z', anchors: ['zulu'] },
    ]);
    const second = await investigateOrphanFunctions(analysisContext([alpha, zulu]), {
      minGroupFunctions: 1,
    });

    expect(second).toEqual(first);
    expect(first.functions.map((item) => item.anchor)).toEqual(['alpha', 'zulu']);
    expect(first.groups.map((item) => item.label)).toEqual(['a', 'z']);
    expect(first.snapshotId).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.groups.every((item) => /^[0-9a-f]{64}$/u.test(item.groupId))).toBe(true);
  });
});

function functionNode(
  id: string,
  filePath: string,
  startLine = 0,
  endLine = startLine,
): FunctionNode {
  return {
    id: id as AnchorId,
    name: id,
    signature: `${id}()`,
    signatureShape: `(sig (scope ) (name ${id}) (ret ))`,
    sourceRange: {
      filePath,
      start: { line: startLine, column: 0 },
      end: { line: endLine, column: 1 },
    },
  } as FunctionNode;
}

function analysisContext(
  functions: readonly FunctionNode[],
  assigned: readonly string[] = [],
): AnalysisContext {
  return {
    repoPath: 'C:\\repo',
    graph: {
      allNodes: () => [],
      edgesFrom: () => [],
    } as unknown as AnalysisContext['graph'],
    files: [],
    functions,
    domains:
      assigned.length === 0
        ? []
        : ([{ implementors: assigned as readonly AnchorId[] }] as unknown as AnalysisContext['domains']),
  } as unknown as AnalysisContext;
}

function arrangeModules(fixtures: readonly ModuleFixture[]): void {
  vi.mocked(evaluateModulesFromGraph).mockResolvedValue({
    modules: fixtures.map((fixture) => ({
      id: fixture.id,
      kind: 'dir',
      label: fixture.label,
      anchors: fixture.anchors as readonly AnchorId[],
      files: [],
    })),
    evaluation: {
      cohesion: fixtures.map((fixture) => ({
        moduleId: fixture.id,
        internalEdges: 0,
        outgoingExternal: 0,
        incomingExternal: 0,
        cohesion: fixture.cohesion ?? 0,
        size: fixture.anchors.length,
      })),
    },
    index: {},
  } as unknown as Awaited<ReturnType<typeof evaluateModulesFromGraph>>);
}
