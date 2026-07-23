/**
 * T35 — C# scope marker codegen.
 *
 * The recorder itself is a committed, reusable library — runtime/csharp/
 * AnatomiaTrace.cs is the single source of truth (usable in Unity / .NET
 * directly). `trace plan --lang csharp` embeds that exact file; this module
 * only resolves it and produces the per-project zone patches.
 */
import { readFileSync } from 'node:fs';
import type { DomainEntryPoint, InjectionPatch } from './inject-cpp.js';

export type { DomainEntryPoint, InjectionPatch };

// Read once per process; src/dynamic and dist/dynamic sit at the same depth,
// so one relative URL serves both (same pattern as inject-cpp.ts).
let cachedCsRuntime: string | undefined;
function csRuntimeLibrary(): string {
  cachedCsRuntime ??= readFileSync(
    new URL('../../runtime/csharp/AnatomiaTrace.cs', import.meta.url),
    'utf8',
  );
  return cachedCsRuntime;
}

/**
 * The C# trace runtime source. `enabled` is kept for API compatibility with
 * generateCppHeader: the library self-gates on ANATOMIA_MEASUREMENT_BUILD
 * (#if / #else no-op), so both variants return the same file.
 */
export function generateCSharpStub(_enabled: boolean): string {
  return csRuntimeLibrary();
}

export function generateCSharpPatches(entryPoints: DomainEntryPoint[]): InjectionPatch[] {
  return entryPoints.map((ep) => ({
    filePath: ep.filePath,
    line: ep.line,
    code: `using var _anatomiaZone = new Anatomia.Zone("${ep.name}", "${ep.anchorId}");`,
  }));
}
