# Anatomia Measurement Build

## Overview

Anatomia's runtime trace layer (G7) inserts scope markers into C++ and C# source files.
Markers compile IN only when `ANATOMIA_MEASUREMENT_BUILD` is defined; otherwise they are
no-ops with zero overhead.

## Compile-time gating

### C++

Define `ANATOMIA_MEASUREMENT_BUILD` at the compiler level (`-DANATOMIA_MEASUREMENT_BUILD`
or `/DANATOMIA_MEASUREMENT_BUILD` on MSVC). The header (`anatomia_zone.h`) expands the
macro to a scoped RAII struct. Without the flag, the macro expands to `/* no-op */`.

```cpp
// With ANATOMIA_MEASUREMENT_BUILD defined:
void Update() {
    ANATOMIA_ZONE("Update", "anchor-abc123");
    // zone_enter on construction, zone_exit on scope exit (destructor)
}
```

### C\#

Define `ANATOMIA_MEASUREMENT_BUILD` as a project-level `DefineConstants` symbol. The
`AnatomiaZone` struct implements `IDisposable`. Use it with a `using` declaration:

```csharp
void Update() {
    using var _ = new Anatomia.AnatomiaZone("Update", "anchor-abc123");
    // zone_enter on ctor, zone_exit on Dispose()
}
```

Without the symbol, the `#else` branch provides a no-op stub so code compiles unchanged.

## KuzuSurvivors: Release-only constraint

KS links against Release-only prebuilt libraries (Rive, etc.). Measurement builds must
therefore be **Release + measurement flag** — never Debug + measurement flag, as the CRT
mismatch causes LNK2038/LNK1319 link failures.

Recommended CMake preset approach:

```cmake
cmake_minimum_required(VERSION 3.20)
option(ANATOMIA_MEASUREMENT "Enable Anatomia zone markers" OFF)
if(ANATOMIA_MEASUREMENT)
  add_compile_definitions(ANATOMIA_MEASUREMENT_BUILD)
endif()
```

Build with: `cmake --build . --config Release -- -DANATOM​IA_MEASUREMENT=ON`
