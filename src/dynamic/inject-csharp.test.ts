import { describe, it, expect } from 'vitest';
import type { AnchorId } from '../types.js';
import { generateCSharpStub, generateCSharpPatches } from './inject-csharp.js';
import type { DomainEntryPoint } from './inject-cpp.js';

describe('generateCSharpStub', () => {
  it('returns the runtime library with a using-scoped Zone', () => {
    const stub = generateCSharpStub(true);
    expect(stub).toContain('IDisposable');
    expect(stub).toContain('struct Zone');
    expect(stub).toContain('class Trace');
  });

  it('self-gates on ANATOMIA_MEASUREMENT_BUILD with a no-op #else branch', () => {
    const stub = generateCSharpStub(true);
    expect(stub).toContain('#if ANATOMIA_MEASUREMENT_BUILD');
    expect(stub).toContain('#else');
    expect(stub).toContain('#endif');
  });

  it('emits the dynamic/protocol.ts wire protocol', () => {
    const stub = generateCSharpStub(true);
    for (const type of ['frame_begin', 'frame_end', 'zone_enter', 'zone_exit']) {
      expect(stub).toContain(type);
    }
    expect(stub).toContain('timestampUs');
    expect(stub).toContain('anchorId');
    expect(stub).toContain('ANATOMIA_TRACE_FILE');
  });

  it('returns the same self-gated file for both enabled variants', () => {
    expect(generateCSharpStub(false)).toBe(generateCSharpStub(true));
  });
});

describe('generateCSharpPatches', () => {
  it('returns one patch per entry point', () => {
    const eps: DomainEntryPoint[] = [
      { filePath: 'Assets/Scripts/Game.cs', line: 20, anchorId: 'abc' as AnchorId, name: 'Update' },
      { filePath: 'Assets/Scripts/Render.cs', line: 55, anchorId: 'def' as AnchorId, name: 'Render' },
    ];
    const patches = generateCSharpPatches(eps);
    expect(patches).toHaveLength(2);
  });

  it('patch scopes an Anatomia.Zone with correct name and anchorId', () => {
    const eps: DomainEntryPoint[] = [
      { filePath: 'Assets/Scripts/Game.cs', line: 20, anchorId: 'myanchor' as AnchorId, name: 'Update' },
    ];
    const patches = generateCSharpPatches(eps);
    expect(patches[0].filePath).toBe('Assets/Scripts/Game.cs');
    expect(patches[0].line).toBe(20);
    expect(patches[0].code).toContain('Anatomia.Zone');
    expect(patches[0].code).toContain('Update');
    expect(patches[0].code).toContain('myanchor');
  });

  it('returns empty array for empty input', () => {
    expect(generateCSharpPatches([])).toEqual([]);
  });
});
