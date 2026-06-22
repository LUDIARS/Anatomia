/**
 * src/domains/retune/grouping.ts — Taxonomy → ownership derivations.
 *
 * The taxonomy (domain × module × {paths,names}) is the source of truth. This
 * module derives, mechanically and deterministically, the two things consumers
 * need from it:
 *   1. `taxonomyToDomainDefs` — DomainDefs (with `membership`) so the existing
 *      detect→domain-view path surfaces the curated domains.
 *   2. `moduleResolver` — a node → module-name function so vis-data can colour /
 *      aggregate by curated module instead of raw directory (domain-view.md).
 *
 * SRP: pure derivation over a Taxonomy. No I/O, no LLM, no graph access.
 */

import type { NodeFilter } from "../../types.js";
import type { DomainDef } from "../ontology.js";
import type { Taxonomy, ModulePlan, DomainPlan, NodeSummary } from "./types.js";

/** NodeFilters a module owns: one per path pattern + one per name pattern. */
export function moduleMembershipFilters(m: ModulePlan): NodeFilter[] {
  const filters: NodeFilter[] = [];
  for (const p of m.paths) if (p) filters.push({ pathPattern: p });
  for (const n of m.names ?? []) if (n) filters.push({ namePattern: n });
  return filters;
}

/** Union of every module's ownership filters in a domain. */
export function domainMembershipFilters(d: DomainPlan): NodeFilter[] {
  return d.modules.flatMap(moduleMembershipFilters);
}

/** Build a membership-only DomainDef (zero rules) from a domain plan. */
export function domainPlanToDef(d: DomainPlan): DomainDef {
  return {
    name: d.name,
    description: d.description,
    presetRules: [],
    templateRules: [],
    membership: domainMembershipFilters(d),
    cardTemplate: `Summarise the "${d.name}" domain: ${d.description}`,
  };
}

/** All domains in a taxonomy as DomainDefs. */
export function taxonomyToDomainDefs(t: Taxonomy): DomainDef[] {
  return t.domains.map(domainPlanToDef);
}

/** Does a node (path/name) belong to this module? + the matched-pattern length. */
function moduleMatch(m: ModulePlan, relPath: string, name: string): number {
  let best = -1;
  for (const p of m.paths) {
    if (!p) continue;
    try {
      if (new RegExp(p).test(relPath)) best = Math.max(best, p.length);
    } catch {
      // Treat an invalid regex as a literal substring (defensive).
      if (relPath.includes(p)) best = Math.max(best, p.length);
    }
  }
  for (const n of m.names ?? []) {
    if (!n) continue;
    try {
      if (new RegExp(n).test(name)) best = Math.max(best, 1);
    } catch {
      if (name === n) best = Math.max(best, 1);
    }
  }
  return best;
}

/**
 * Resolve a node to its owning { domain, module }. When several modules match,
 * the one with the longest matched path pattern wins (most specific). Returns
 * null when no module owns the node.
 */
export function assignNodeToModule(
  taxonomy: Taxonomy,
  relPath: string,
  name: string,
): { domain: string; module: string } | null {
  let winner: { domain: string; module: string } | null = null;
  let winnerScore = -1;
  for (const d of taxonomy.domains) {
    for (const m of d.modules) {
      const score = moduleMatch(m, relPath, name);
      if (score > winnerScore) {
        winnerScore = score;
        winner = { domain: d.name, module: m.name };
      }
    }
  }
  return winner;
}

/**
 * A resolver for buildVisData's optional `moduleResolver`: returns the curated
 * module name for a node, or null to fall back to directory grouping.
 */
export function moduleResolver(taxonomy: Taxonomy): (relPath: string, name: string) => string | null {
  return (relPath, name) => assignNodeToModule(taxonomy, relPath, name)?.module ?? null;
}

/** Nodes not owned by any module in the taxonomy. */
export function unassignedNodes(taxonomy: Taxonomy, nodes: NodeSummary[]): NodeSummary[] {
  return nodes.filter((n) => assignNodeToModule(taxonomy, n.relPath, n.name) === null);
}
