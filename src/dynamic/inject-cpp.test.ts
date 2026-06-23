import { describe, it, expect } from 'vitest';
import type { AnchorId, AstNode } from '../types.js';
import type { FunctionNode } from '../types.js';
import {
  generateCppHeader,
  generateCppPatches,
  detectMainLoopCandidates,
  generateFrameMarkerPatches,
} from './inject-cpp.js';
import type { DomainEntryPoint } from './inject-cpp.js';

describe('generateCppHeader', () => {
  it('enabled=true contains ANATOMIA_ZONE macro and struct', () => {
    const header = generateCppHeader(true);
    expect(header).toContain('ANATOMIA_ZONE');
    expect(header).toContain('struct');
  });

  it('enabled=true contains Zone struct with name and anchorId fields', () => {
    const header = generateCppHeader(true);
    expect(header).toContain('Zone');
    expect(header).toContain('name');
    expect(header).toContain('anchorId');
  });

  it('enabled=false contains /* no-op */', () => {
    const header = generateCppHeader(false);
    expect(header).toContain('/* no-op */');
    // Should not define a struct
    expect(header).not.toContain('struct Zone');
  });

  it('enabled=false still defines ANATOMIA_ZONE', () => {
    const header = generateCppHeader(false);
    expect(header).toContain('ANATOMIA_ZONE');
  });
});

describe('generateCppPatches', () => {
  it('returns one patch per entry point', () => {
    const eps: DomainEntryPoint[] = [
      { filePath: 'src/game.cpp', line: 42, anchorId: 'abc123' as AnchorId, name: 'UpdateGame' },
      { filePath: 'src/render.cpp', line: 100, anchorId: 'def456' as AnchorId, name: 'RenderFrame' },
    ];
    const patches = generateCppPatches(eps);
    expect(patches).toHaveLength(2);
  });

  it('patch contains ANATOMIA_ZONE call with correct name and anchorId', () => {
    const eps: DomainEntryPoint[] = [
      { filePath: 'src/game.cpp', line: 42, anchorId: 'abc123' as AnchorId, name: 'UpdateGame' },
    ];
    const patches = generateCppPatches(eps);
    expect(patches[0].filePath).toBe('src/game.cpp');
    expect(patches[0].line).toBe(42);
    expect(patches[0].code).toContain('ANATOMIA_ZONE');
    expect(patches[0].code).toContain('UpdateGame');
    expect(patches[0].code).toContain('abc123');
  });

  it('returns empty array for empty input', () => {
    expect(generateCppPatches([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Frame-marker auto-detection tests
// ---------------------------------------------------------------------------

/** Build a minimal FunctionNode for detection tests (no real tree-sitter node). */
function makeFn(
  name: string,
  opts: {
    enclosingType?: string;
    filePath?: string;
    startLine?: number;
    endLine?: number;
    childCount?: number;
  } = {},
): FunctionNode {
  const noopAst: AstNode = {
    type: "compound_statement",
    childCount: opts.childCount ?? 0,
    startPosition: { row: opts.startLine ?? 0, column: 0 },
    endPosition: { row: opts.endLine ?? 10, column: 1 },
    child: (_: number) => null,
    childForFieldName: (_: string) => null,
  } as unknown as AstNode;

  return {
    id: `anchor_${name}` as AnchorId,
    name,
    signature: `void ${name}()`,
    enclosingType: opts.enclosingType,
    sourceRange: {
      filePath: opts.filePath ?? `/src/${name}.cpp`,
      start: { line: opts.startLine ?? 0, column: 0 },
      end: { line: opts.endLine ?? 10, column: 1 },
    },
    bodyAst: noopAst,
  };
}

describe('detectMainLoopCandidates — heuristic names', () => {
  it('detects main, run, loop by default heuristic', () => {
    const fns = ['main', 'run', 'loop', 'helper', 'init'].map((n) => makeFn(n));
    const candidates = detectMainLoopCandidates(fns);
    const names = candidates.map((c) => c.name);
    expect(names).toContain('main');
    expect(names).toContain('run');
    expect(names).toContain('loop');
    expect(names).not.toContain('helper');
    expect(names).not.toContain('init');
  });

  it('detects GameLoop and MainLoop by heuristic', () => {
    const fns = ['GameLoop', 'MainLoop', 'update'].map((n) => makeFn(n));
    const candidates = detectMainLoopCandidates(fns);
    const names = candidates.map((c) => c.name);
    expect(names).toContain('GameLoop');
    expect(names).toContain('MainLoop');
    expect(names).not.toContain('update');
  });

  it('returns empty array when no heuristic match', () => {
    const fns = ['update', 'render', 'init'].map((n) => makeFn(n));
    expect(detectMainLoopCandidates(fns)).toHaveLength(0);
  });
});

describe('detectMainLoopCandidates — mainLoopHint', () => {
  it('matches exact name case-insensitively', () => {
    const fns = ['GameApplication', 'helper'].map((n) => makeFn(n));
    const candidates = detectMainLoopCandidates(fns, 'gameapplication');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.name).toBe('GameApplication');
  });

  it('matches suffix ::hint pattern (method form)', () => {
    const fn = makeFn('run', { enclosingType: 'App' });
    // name is "run" (not "App::run") — suffix match covers this
    const candidates = detectMainLoopCandidates([fn], 'run');
    expect(candidates).toHaveLength(1);
  });

  it('does not match when hint is unrelated', () => {
    const fns = ['main', 'run', 'loop'].map((n) => makeFn(n));
    expect(detectMainLoopCandidates(fns, 'customLoop')).toHaveLength(0);
  });
});

describe('detectMainLoopCandidates — precision fallback', () => {
  it('uses function boundary when no inner loop found (childCount=0)', () => {
    const fn = makeFn('main', { startLine: 5, endLine: 20 });
    const candidates = detectMainLoopCandidates([fn]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.precision).toBe('function');
    expect(candidates[0]!.frameBeginLine).toBe(6); // start+1
    expect(candidates[0]!.frameEndLine).toBe(20);
  });
});

describe('generateFrameMarkerPatches', () => {
  it('returns two patches per candidate (begin + end)', () => {
    const fn = makeFn('main');
    const candidates = detectMainLoopCandidates([fn]);
    const patches = generateFrameMarkerPatches(candidates);
    expect(patches).toHaveLength(2);
  });

  it('begin patch contains ANATOMIA_FRAME_BEGIN', () => {
    const fn = makeFn('run');
    const candidates = detectMainLoopCandidates([fn]);
    const patches = generateFrameMarkerPatches(candidates);
    expect(patches[0]!.code).toContain('ANATOMIA_FRAME_BEGIN');
  });

  it('end patch contains ANATOMIA_FRAME_END', () => {
    const fn = makeFn('run');
    const candidates = detectMainLoopCandidates([fn]);
    const patches = generateFrameMarkerPatches(candidates);
    expect(patches[1]!.code).toContain('ANATOMIA_FRAME_END');
  });

  it('returns empty array for empty candidates', () => {
    expect(generateFrameMarkerPatches([])).toEqual([]);
  });
});
