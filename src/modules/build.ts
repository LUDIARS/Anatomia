/**
 * src/modules/build.ts — Build the 機能(module) partition from functions.
 *
 * Deterministic structural grouping:
 *   "dir"   — by source directory (matches the panel's vis-data group);
 *   "class" — by enclosing class (`<file>::<Class>`), falling back to the
 *             directory for free functions with no enclosingType.
 * The result is a partition (every anchored function lands in exactly one
 * module), sorted for stable output.
 *
 * SRP: functions → ModuleUnit[] only. Cohesion scoring is cohesion.ts.
 */

import type { AnchorId, FunctionNode } from "../types.js";
import type { ModuleGranularity, ModuleUnit } from "./types.js";

/** Normalise to forward slashes. */
function fwd(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Directory of a path (fwd), or "." when top-level. */
function dirOf(path: string): string {
  const f = fwd(path);
  const slash = f.lastIndexOf("/");
  return slash >= 0 ? f.slice(0, slash) : ".";
}

/** Last path segment (display label). */
function lastSeg(path: string): string {
  const f = fwd(path);
  const slash = f.lastIndexOf("/");
  return slash >= 0 ? f.slice(slash + 1) : f;
}

/** Compute the module id + label + kind for one function at a granularity. */
function moduleKeyFor(
  fn: FunctionNode,
  granularity: ModuleGranularity,
): { id: string; label: string; kind: ModuleGranularity } {
  const file = fwd(fn.sourceRange.filePath);
  if (granularity === "class" && fn.enclosingType) {
    // Key by DIRECTORY + class, not file + class, so a class split across its
    // header/translation-unit (`foo.h` declaration + `foo.cpp` definition, which
    // live in the same directory) folds into ONE module instead of two. A
    // same-named class in a different directory stays distinct (the dir scopes it).
    const dir = dirOf(file);
    return { id: `${dir}#${fn.enclosingType}`, label: fn.enclosingType, kind: "class" };
  }
  const dir = dirOf(file);
  return { id: dir, label: lastSeg(dir), kind: "dir" };
}

/** Partition anchored functions into modules at the given granularity. */
export function buildModules(
  functions: FunctionNode[],
  granularity: ModuleGranularity = "dir",
): ModuleUnit[] {
  const groups = new Map<string, { label: string; kind: ModuleGranularity; anchors: Set<AnchorId>; files: Set<string> }>();
  for (const fn of functions) {
    if (!fn.id) continue;
    const { id, label, kind } = moduleKeyFor(fn, granularity);
    let g = groups.get(id);
    if (!g) {
      g = { label, kind, anchors: new Set(), files: new Set() };
      groups.set(id, g);
    }
    g.anchors.add(fn.id);
    g.files.add(fwd(fn.sourceRange.filePath));
  }
  return [...groups.entries()]
    .map(([id, g]) => ({
      id,
      kind: g.kind,
      label: g.label,
      anchors: [...g.anchors].sort(),
      files: [...g.files].sort(),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Build an anchor → moduleId index for a module partition. */
export function moduleIndex(modules: ModuleUnit[]): Map<AnchorId, string> {
  const index = new Map<AnchorId, string>();
  for (const m of modules) {
    for (const a of m.anchors) index.set(a, m.id);
  }
  return index;
}
