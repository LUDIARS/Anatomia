/**
 * T34 — C++ scope marker codegen.
 */
import type { AnchorId } from '../types.js';

export function generateCppHeader(enabled: boolean): string {
  if (enabled) {
    return `#pragma once
// Anatomia measurement instrumentation header.
// Include in translation units compiled with ANATOMIA_MEASUREMENT_BUILD defined.

#ifdef ANATOMIA_MEASUREMENT_BUILD
#include <cstdint>

namespace anatomia {
  struct Zone {
    const char* name;
    const char* anchorId;
    Zone(const char* name_, const char* anchorId_) : name(name_), anchorId(anchorId_) {
      // zone_enter event would be emitted here in a real runtime
    }
    ~Zone() {
      // zone_exit event would be emitted here in a real runtime
    }
  };
} // namespace anatomia

#define ANATOMIA_ZONE(name, anchorId) ::anatomia::Zone _anatomia_zone_##__LINE__(name, anchorId)
#else
#define ANATOMIA_ZONE(name, anchorId) /* no-op */
#endif
`;
  } else {
    return `#pragma once
// Anatomia measurement instrumentation header (disabled).
// Compile with ANATOMIA_MEASUREMENT_BUILD to enable zone markers.

#define ANATOMIA_ZONE(name, anchorId) /* no-op */
`;
  }
}

export interface MechanicEntryPoint {
  filePath: string;
  line: number;
  anchorId: AnchorId;
  name: string;
}

export interface InjectionPatch {
  filePath: string;
  line: number;
  code: string;
}

export function generateCppPatches(entryPoints: MechanicEntryPoint[]): InjectionPatch[] {
  return entryPoints.map((ep) => ({
    filePath: ep.filePath,
    line: ep.line,
    code: `ANATOMIA_ZONE("${ep.name}", "${ep.anchorId}");`,
  }));
}
