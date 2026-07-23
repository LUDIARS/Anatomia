/**
 * runtime/ trace libraries — source-of-truth pinning + wire-protocol contract.
 *
 * The C++ (runtime/cpp/anatomia_trace.hpp) and C# (runtime/csharp/
 * AnatomiaTrace.cs) recorders are committed libraries games vendor directly.
 * These tests pin the generators to those files and verify the exact JSONL
 * lines the libraries emit stay parseable by dynamic/record/ingest.ts.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { generateCppHeader } from './inject-cpp.js';
import { generateCSharpStub } from './inject-csharp.js';
import { parseTraceJsonl } from './record/ingest.js';

const cppLib = readFileSync(new URL('../../runtime/cpp/anatomia_trace.hpp', import.meta.url), 'utf8');
const csLib = readFileSync(new URL('../../runtime/csharp/AnatomiaTrace.cs', import.meta.url), 'utf8');

describe('runtime library pinning', () => {
  it('generateCppHeader(true) embeds the committed C++ library verbatim', () => {
    expect(generateCppHeader(true)).toBe(cppLib);
  });

  it('generateCSharpStub embeds the committed C# library verbatim', () => {
    expect(generateCSharpStub(true)).toBe(csLib);
  });

  it('both libraries speak the dynamic/protocol.ts vocabulary', () => {
    for (const lib of [cppLib, csLib]) {
      for (const token of [
        'frame_begin', 'frame_end', 'zone_enter', 'zone_exit',
        'frameId', 'anchorId', 'timestampUs',
        'ANATOMIA_TRACE_FILE', 'ANATOMIA_TRACE_FLUSH', 'ANATOMIA_MEASUREMENT_BUILD',
      ]) {
        expect(lib).toContain(token);
      }
    }
  });
});

describe('wire-protocol contract', () => {
  // These lines replicate the libraries' fprintf / Write output byte-for-byte.
  const emitted = [
    '{"type":"frame_begin","frameId":1,"timestampUs":100}',
    '{"type":"zone_enter","anchorId":"abc123","timestampUs":105}',
    '{"type":"zone_exit","anchorId":"abc123","timestampUs":190}',
    '{"type":"frame_end","frameId":1,"timestampUs":200}',
  ].join('\n') + '\n';

  it('lines as the recorders format them parse into TraceEvents', () => {
    const events = parseTraceJsonl(emitted);
    expect(events).toHaveLength(4);
    expect(events[0]).toEqual({ type: 'frame_begin', frameId: 1, timestampUs: 100 });
    expect(events[1]).toEqual({ type: 'zone_enter', anchorId: 'abc123', timestampUs: 105 });
    expect(events[3]).toEqual({ type: 'frame_end', frameId: 1, timestampUs: 200 });
  });

  it('tolerates a truncated final line (recorder killed mid-write)', () => {
    const events = parseTraceJsonl(emitted + '{"type":"zone_en');
    expect(events).toHaveLength(4);
  });
});
