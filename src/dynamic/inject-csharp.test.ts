import { describe, it, expect } from 'vitest';
import type { AnchorId } from '../types.js';
import { generateCSharpStub, generateCSharpPatches } from './inject-csharp.js';
import type { MechanicEntryPoint } from './inject-cpp.js';

describe('generateCSharpStub', () => {
  it('enabled=true contains IDisposable and AnatomiaZone', () => {
    const stub = generateCSharpStub(true);
    expect(stub).toContain('IDisposable');
    expect(stub).toContain('AnatomiaZone');
  });

  it('enabled=true is wrapped in #if ANATOMIA_MEASUREMENT_BUILD', () => {
    const stub = generateCSharpStub(true);
    expect(stub).toContain('#if ANATOMIA_MEASUREMENT_BUILD');
    expect(stub).toContain('#endif');
  });

  it('enabled=false contains no-op pattern', () => {
    const stub = generateCSharpStub(false);
    // Should have AnatomiaZone struct but as no-op
    expect(stub).toContain('AnatomiaZone');
    // The no-op version has empty constructors
    expect(stub).toContain('#else');
  });

  it('enabled=false still wraps in #if/#endif', () => {
    const stub = generateCSharpStub(false);
    expect(stub).toContain('#if ANATOMIA_MEASUREMENT_BUILD');
    expect(stub).toContain('#endif');
  });
});

describe('generateCSharpPatches', () => {
  it('returns one patch per entry point', () => {
    const eps: MechanicEntryPoint[] = [
      { filePath: 'Assets/Scripts/Game.cs', line: 20, anchorId: 'abc' as AnchorId, name: 'Update' },
      { filePath: 'Assets/Scripts/Render.cs', line: 55, anchorId: 'def' as AnchorId, name: 'Render' },
    ];
    const patches = generateCSharpPatches(eps);
    expect(patches).toHaveLength(2);
  });

  it('patch contains AnatomiaZone with correct name and anchorId', () => {
    const eps: MechanicEntryPoint[] = [
      { filePath: 'Assets/Scripts/Game.cs', line: 20, anchorId: 'myanchor' as AnchorId, name: 'Update' },
    ];
    const patches = generateCSharpPatches(eps);
    expect(patches[0].filePath).toBe('Assets/Scripts/Game.cs');
    expect(patches[0].line).toBe(20);
    expect(patches[0].code).toContain('AnatomiaZone');
    expect(patches[0].code).toContain('Update');
    expect(patches[0].code).toContain('myanchor');
  });

  it('returns empty array for empty input', () => {
    expect(generateCSharpPatches([])).toEqual([]);
  });
});
