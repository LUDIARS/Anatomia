import { describe, it, expect } from 'vitest';
import type { AnchorId } from '../types.js';
import { generateCppHeader, generateCppPatches } from './inject-cpp.js';
import type { MechanicEntryPoint } from './inject-cpp.js';

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
    const eps: MechanicEntryPoint[] = [
      { filePath: 'src/game.cpp', line: 42, anchorId: 'abc123' as AnchorId, name: 'UpdateGame' },
      { filePath: 'src/render.cpp', line: 100, anchorId: 'def456' as AnchorId, name: 'RenderFrame' },
    ];
    const patches = generateCppPatches(eps);
    expect(patches).toHaveLength(2);
  });

  it('patch contains ANATOMIA_ZONE call with correct name and anchorId', () => {
    const eps: MechanicEntryPoint[] = [
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
