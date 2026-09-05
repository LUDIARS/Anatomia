/**
 * src/supply/plan/layer-warnings.ts — Layer-direction warnings for a plan
 * (design §7.2 A-11).
 *
 * `plan` already says which layer each piece's exemplar lives in, but it never
 * looked at the direction BETWEEN the pieces. A layer violation that is
 * predictable before the first line is written should be said before the first
 * line is written, not left for `layerViolation` to find in review.
 *
 * The dependency direction is NOT inferred from `plannedPaths`: a set of paths
 * says where code will go, never which piece calls which. The edges come from
 * the decomposition's own `dependsOn`, and when the deterministic fallback
 * cannot state them the plan carries an empty list plus a note saying so — an
 * unstated dependency is not the same as no dependency.
 *
 * A warning is a WARNING: `plan` is not a gate and its exit code does not move.
 *
 * SRP: warnings + the item→layer resolution they need. No rendering, no I/O.
 *
 * @spec plan item 間の層依存の事前警告 (A-11)
 */

import { buildLayerPolicy, layerOfPath } from "../../domains/program/index.js";
import type { ProgramDomainConfig } from "../../domains/program/types.js";
import type { PlanItem, PlanLayerWarning, PlanUnresolved } from "./types.js";

/** What {@link buildPlanLayerWarnings} concluded. */
export interface PlanLayerAnalysis {
  warnings: PlanLayerWarning[];
  /** Dependency edges whose layers could not be decided, as unresolved entries. */
  unresolved: PlanUnresolved[];
}

/**
 * The layer a plan item will be written into, or null when it cannot be decided.
 *
 * Every planned path must agree: a piece spread over two layers has no single
 * layer, and picking the majority would turn an ambiguity into a false verdict.
 * A `new` domain with no planned path has no layer either — a domain nobody has
 * placed yet is exactly the case A-11 must not judge.
 */
export function itemLayer(config: ProgramDomainConfig, item: PlanItem): string | null {
  const layers = new Set(
    item.plannedPaths
      .map((path) => layerOfPath(config, path))
      .filter((layer): layer is string => layer !== null),
  );
  if (layers.size !== 1) return null;
  if (item.plannedPaths.some((path) => layerOfPath(config, path) === null)) return null;
  return [...layers][0]!;
}

/**
 * Check every `dependsOn` edge against the repository's layer policy (A-7, or
 * the builtin ranking when the repo declares none).
 */
export function buildPlanLayerWarnings(
  items: readonly PlanItem[],
  config: ProgramDomainConfig,
): PlanLayerAnalysis {
  const policy = buildLayerPolicy(config);
  const byId = new Map(items.map((item) => [item.id, item] as const));
  const layers = new Map(items.map((item) => [item.id, itemLayer(config, item)] as const));
  const warnings: PlanLayerWarning[] = [];
  const unresolved: PlanUnresolved[] = [];

  for (const item of items) {
    for (const targetId of item.dependsOn) {
      const target = byId.get(targetId);
      if (!target) {
        unresolved.push({
          repo: item.repo,
          subject: `${item.id} -> ${targetId}`,
          reason: "依存先の plan item が存在しません",
        });
        continue;
      }
      const from = layers.get(item.id) ?? null;
      const to = layers.get(target.id) ?? null;
      if (from === null || to === null) {
        unresolved.push({
          repo: item.repo,
          subject: `${item.id} -> ${target.id}`,
          reason: from === null && to === null
            ? "両 item の層が決まらないため層間依存を判定できません"
            : `${from === null ? item.id : target.id} の層が決まらないため層間依存を判定できません`,
        });
        continue;
      }
      if (policy.allows(from, to) !== false) continue;
      warnings.push({
        fromItemId: item.id,
        toItemId: target.id,
        fromLayer: from,
        toLayer: to,
        reason: `層 ${from} から ${to} への依存は層宣言 (${policy.source}) が許していません`,
      });
    }
  }

  warnings.sort((left, right) =>
    left.fromItemId.localeCompare(right.fromItemId) || left.toItemId.localeCompare(right.toItemId));
  unresolved.sort((left, right) => left.subject.localeCompare(right.subject));
  return { warnings, unresolved };
}
