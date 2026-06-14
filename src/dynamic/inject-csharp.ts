/**
 * T35 — C# scope marker codegen.
 */
import type { AnchorId } from '../types.js';
import type { MechanicEntryPoint, InjectionPatch } from './inject-cpp.js';

export type { MechanicEntryPoint, InjectionPatch };

export function generateCSharpStub(enabled: boolean): string {
  if (enabled) {
    return `#if ANATOMIA_MEASUREMENT_BUILD
using System;

namespace Anatomia
{
    /// <summary>
    /// Scoped zone marker for Anatomia runtime measurement.
    /// Use with a <c>using</c> statement: <c>using var _ = new AnatomiaZone("name", "anchorId");</c>
    /// </summary>
    public struct AnatomiaZone : IDisposable
    {
        private readonly string _name;
        private readonly string _anchorId;

        public AnatomiaZone(string name, string anchorId)
        {
            _name = name;
            _anchorId = anchorId;
            // zone_enter event emitted here in real runtime
        }

        public void Dispose()
        {
            // zone_exit event emitted here in real runtime
        }
    }
}
#endif
`;
  } else {
    return `#if ANATOMIA_MEASUREMENT_BUILD
// Full AnatomiaZone implementation compiled in measurement builds.
#else
namespace Anatomia
{
    /// <summary>No-op AnatomiaZone for non-measurement builds.</summary>
    public struct AnatomiaZone : System.IDisposable
    {
        public AnatomiaZone(string name, string anchorId) { }
        public void Dispose() { }
    }
}
#endif
`;
  }
}

export function generateCSharpPatches(entryPoints: MechanicEntryPoint[]): InjectionPatch[] {
  return entryPoints.map((ep) => ({
    filePath: ep.filePath,
    line: ep.line,
    code: `using var _anatomiaZone = new Anatomia.AnatomiaZone("${ep.name}", "${ep.anchorId}");`,
  }));
}
