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

/** File base-name stem (last segment without the final extension, lower-cased). */
function stemOf(path: string): string {
  const seg = lastSeg(path);
  const dot = seg.lastIndexOf(".");
  return (dot > 0 ? seg.slice(0, dot) : seg).toLowerCase();
}

/** Collect the lowercase stems of all files in a set. */
function stemsOf(files: Set<string>): Set<string> {
  const s = new Set<string>();
  for (const f of files) s.add(stemOf(f));
  return s;
}

/** True when two sets share at least one element. */
function setsOverlap<T>(a: Set<T>, b: Set<T>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/**
 * Lowest-common-ancestor directory of the given file paths.
 * Used as the dir prefix when merging a cross-directory class split.
 */
function lcaDirOf(files: Iterable<string>): string {
  const dirs = [...files].map((f) => dirOf(f));
  if (dirs.length === 0) return ".";
  const parts = dirs.map((d) => d.split("/"));
  let len = parts[0]!.length;
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]!;
    let k = 0;
    while (k < len && k < p.length && parts[0]![k] === p[k]) k++;
    if (k < len) len = k;
    if (len === 0) break;
  }
  if (len === 0) return ".";
  return parts[0]!.slice(0, len).join("/") || ".";
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

type GroupEntry = {
  label: string;
  kind: ModuleGranularity;
  anchors: Set<AnchorId>;
  files: Set<string>;
};

/**
 * Post-process class-granularity groups to merge cross-directory splits of the
 * same class. Two groups merge when they share the same class name (label) AND
 * their file sets have at least one overlapping base-name stem — the canonical
 * C++ pattern of splitting a class across directories (`include/Foo.h` + `src/Foo.cpp`).
 *
 * Merging is transitive (union-find), so a class spread across three directories
 * collapses into one module. The merged id uses the lowest-common-ancestor
 * directory of all its files (`<lca>#ClassName`), preserving the same-dir id
 * when no cross-dir split occurs.
 *
 * Classes with the same name but disjoint file stems stay separate.
 */
function mergeClassGroups(groups: Map<string, GroupEntry>): Map<string, GroupEntry> {
  const classEntries: Array<[string, GroupEntry]> = [];
  const result = new Map<string, GroupEntry>();

  for (const [id, g] of groups) {
    if (g.kind === "class") {
      classEntries.push([id, g]);
    } else {
      result.set(id, g); // dir-fallback groups pass through unchanged
    }
  }

  // Bucket by class name so we only compare within the same name.
  const byLabel = new Map<string, Array<[string, GroupEntry]>>();
  for (const entry of classEntries) {
    const label = entry[1].label;
    const bucket = byLabel.get(label) ?? [];
    bucket.push(entry);
    byLabel.set(label, bucket);
  }

  for (const [, entries] of byLabel) {
    if (entries.length === 1) {
      const [id, g] = entries[0]!;
      result.set(id, g);
      continue;
    }

    // Union-Find to detect connected components by stem overlap.
    const n = entries.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]!]!;
        i = parent[i]!;
      }
      return i;
    };
    const union = (i: number, j: number): void => {
      parent[find(i)] = find(j);
    };

    const stemSets = entries.map(([, g]) => stemsOf(g.files));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (setsOverlap(stemSets[i]!, stemSets[j]!)) union(i, j);
      }
    }

    // Collect one merged GroupEntry per connected component.
    const components = new Map<number, GroupEntry>();
    for (let i = 0; i < n; i++) {
      const root = find(i);
      const [, g] = entries[i]!;
      const comp = components.get(root);
      if (!comp) {
        components.set(root, {
          label: g.label,
          kind: "class",
          anchors: new Set(g.anchors),
          files: new Set(g.files),
        });
      } else {
        for (const a of g.anchors) comp.anchors.add(a);
        for (const f of g.files) comp.files.add(f);
      }
    }

    for (const comp of components.values()) {
      const id = `${lcaDirOf(comp.files)}#${comp.label}`;
      result.set(id, comp);
    }
  }

  return result;
}

/** Partition anchored functions into modules at the given granularity. */
export function buildModules(
  functions: FunctionNode[],
  granularity: ModuleGranularity = "dir",
): ModuleUnit[] {
  const groups = new Map<string, GroupEntry>();
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

  const resolved = granularity === "class" ? mergeClassGroups(groups) : groups;

  return [...resolved.entries()]
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
