/**
 * src/domains/retune/taxonomy-ops.ts — Mechanical taxonomy mutations.
 *
 * Pure, deterministic operations that build/refine a Taxonomy: create domains &
 * modules, attach directory path patterns, count nodes per module, split a
 * domain into sub-domains, merge modules. No LLM, no I/O — steps.ts decides
 * WHAT to do (often via the LLM); this file does it.
 *
 * SRP: taxonomy data structure mutations only.
 */

import type { Taxonomy, DomainPlan, ModulePlan, NodeSummary } from "./types.js";
import { assignNodeToModule } from "./grouping.js";

/** Escape a string for use as a literal inside a RegExp. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A node-owning path pattern for a directory: matches files DIRECTLY in that dir
 * (not its sub-directories — those are separate dirs owned by their own module).
 *
 * Two design points that bit during bring-up:
 *  - `(^|/)` segment boundary, NOT `^`: matchesFilter (predicate.ts) tests the
 *    node's ABSOLUTE forward-slashed path (`E:/…/src/graph/build.ts`), while the
 *    vis-data resolver tests the REPO-RELATIVE path (`src/graph/build.ts`). The
 *    `(^|/)` prefix matches the dir as a path segment in both.
 *  - `/[^/]+$` direct-children tail avoids the catch-all where a shallow dir like
 *    "src" would otherwise swallow every nested file.
 */
export function pathPatternForDir(dir: string): string {
  const norm = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  return `(^|/)${escapeRegex(norm)}/[^/]+$`;
}

/** Lower-case kebab-case an LLM-supplied name into a stable id token. */
export function kebab(name: string): string {
  const s = (name ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length > 0 ? s : "unnamed";
}

export function emptyTaxonomy(project: string): Taxonomy {
  return { version: 1, project, iterations: 0, domains: [] };
}

export function findOrCreateDomain(t: Taxonomy, name: string, description: string): DomainPlan {
  const id = kebab(name);
  let d = t.domains.find((x) => x.name === id);
  if (!d) {
    d = { name: id, description: description || id, modules: [] };
    t.domains.push(d);
  }
  return d;
}

export function findOrCreateModule(d: DomainPlan, name: string, description: string): ModulePlan {
  const id = kebab(name);
  let m = d.modules.find((x) => x.name === id);
  if (!m) {
    m = { name: id, description: description || id, paths: [] };
    d.modules.push(m);
  }
  return m;
}

/** Attach a directory's path pattern to a module (idempotent). */
export function addDir(m: ModulePlan, dir: string): void {
  const p = pathPatternForDir(dir);
  if (!m.paths.includes(p)) m.paths.push(p);
}

/** Count owned nodes per "domain/module" key. */
export function moduleNodeCounts(t: Taxonomy, nodes: NodeSummary[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const a = assignNodeToModule(t, n.relPath, n.name);
    if (!a) continue;
    const key = `${a.domain}/${a.module}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Find a module by name across all domains (returns its domain too). */
export function findModule(
  t: Taxonomy,
  moduleName: string,
): { domain: DomainPlan; module: ModulePlan } | null {
  const id = kebab(moduleName);
  for (const d of t.domains) {
    const m = d.modules.find((x) => x.name === id);
    if (m) return { domain: d, module: m };
  }
  return null;
}

/**
 * Replace a domain with sub-domains, partitioning its modules. `partition` maps
 * sub-domain {name,description} → the module names it takes. Modules not named
 * in any partition stay on the first sub-domain (so nothing is dropped).
 */
export function splitDomain(
  t: Taxonomy,
  domainName: string,
  partition: { name: string; description: string; modules: string[] }[],
): boolean {
  const idx = t.domains.findIndex((d) => d.name === kebab(domainName));
  if (idx < 0 || partition.length === 0) return false;
  const original = t.domains[idx]!;
  const byId = new Map(original.modules.map((m) => [m.name, m]));
  const taken = new Set<string>();
  const subs: DomainPlan[] = partition.map((p) => {
    const mods: ModulePlan[] = [];
    for (const mn of p.modules) {
      const m = byId.get(kebab(mn));
      if (m && !taken.has(m.name)) {
        mods.push(m);
        taken.add(m.name);
      }
    }
    return { name: kebab(p.name), description: p.description || p.name, modules: mods };
  });
  // Any module not assigned to a sub-domain falls to the first sub-domain.
  for (const m of original.modules) {
    if (!taken.has(m.name)) subs[0]!.modules.push(m);
  }
  t.domains.splice(idx, 1, ...subs.filter((s) => s.modules.length > 0));
  return true;
}

/**
 * Merge several modules (within one domain) into a single module `into`. The
 * merged module unions the source modules' paths + names. Sources are removed.
 */
export function mergeModules(
  t: Taxonomy,
  domainName: string,
  into: string,
  description: string,
  moduleNames: string[],
): boolean {
  const d = t.domains.find((x) => x.name === kebab(domainName));
  if (!d) return false;
  const ids = new Set(moduleNames.map(kebab));
  const sources = d.modules.filter((m) => ids.has(m.name));
  if (sources.length < 2) return false;
  const target: ModulePlan = { name: kebab(into), description: description || into, paths: [], names: [] };
  for (const m of sources) {
    for (const p of m.paths) if (!target.paths.includes(p)) target.paths.push(p);
    for (const n of m.names ?? []) {
      target.names!.push(n);
    }
  }
  if (target.names!.length === 0) delete target.names;
  d.modules = d.modules.filter((m) => !ids.has(m.name));
  d.modules.push(target);
  return true;
}
