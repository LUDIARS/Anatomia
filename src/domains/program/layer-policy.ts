// @spec プログラムドメイン
/**
 * src/domains/program/layer-policy.ts — Which layer may depend on which.
 *
 * The layer order used to be hard-coded (`LAYER_RANK`: infrastructure < domain
 * < application < presentation). Real repositories have a different number of
 * layers, and an onion architecture is not a total order at all — it is a set
 * of "may point inwards" rules. A repository therefore declares its own policy
 * in `.anatomia/layers.json`:
 *
 *   - `order: [...]`   — inner-to-outer. A layer may depend on layers at or
 *                        before its own position; depending outwards violates.
 *   - `allow: {from: [to, ...]}` — explicit, exhaustive over the repo's own
 *                        declared layers. An onion is expressed by listing only
 *                        the inward targets. `allow` wins over `order`.
 *
 * A repository with neither keeps the builtin ranking, so an existing checkout's
 * verdicts do not change when this file lands.
 *
 * SRP: the dependency-direction decision only. Loading and validating the file
 * is config.ts; applying the verdict to real edges is program-domain-view.ts.
 */

import type { ProgramDomainConfig } from "./types.js";

/** The layer names the builtin ranking (and the builtin classifiers) know. */
export const BUILTIN_LAYERS = ["infrastructure", "domain", "application", "presentation"] as const;

const LAYER_RANK: Record<string, number> = { infrastructure: 0, domain: 1, application: 2, presentation: 3 };

/** How a dependency direction is judged. */
export interface LayerPolicy {
  /** Which declaration produced the verdicts. */
  source: "declared-allow" | "declared-order" | "builtin";
  /** Layer names this policy can judge, in declared order when it has one. */
  layers: string[];
  /**
   * `true` allowed, `false` a violation, `null` when the policy cannot judge
   * (a layer it was never told about). A null is NOT a violation: an unjudgeable
   * edge must not be reported as a broken rule.
   */
  allows(from: string, to: string): boolean | null;
}

/** Build the effective policy for a loaded layer configuration. */
export function buildLayerPolicy(config: ProgramDomainConfig): LayerPolicy {
  if (config.allow) {
    const allow = config.allow;
    // `allow` decides the verdicts, but `order` — when both are declared — is
    // still what a reader means by "the layer order", so it drives the display
    // order of the layer figure and the by-layer review.
    const keys = Object.keys(allow);
    const layers = [
      ...(config.order ?? []).filter((layer) => keys.includes(layer)),
      ...keys.filter((layer) => !(config.order ?? []).includes(layer)).sort(),
    ];
    return {
      source: "declared-allow",
      layers,
      allows(from, to) {
        if (from === to) return true;
        const targets = allow[from];
        if (!targets) return null;
        return targets.includes(to);
      },
    };
  }
  if (config.order) {
    const order = config.order;
    const rank = new Map(order.map((layer, index) => [layer, index] as const));
    return {
      source: "declared-order",
      layers: [...order],
      allows(from, to) {
        const left = rank.get(from); const right = rank.get(to);
        if (left === undefined || right === undefined) return null;
        return left >= right;
      },
    };
  }
  return {
    source: "builtin",
    layers: [...BUILTIN_LAYERS],
    // The historical rule, including its `?? 0` treatment of an unknown layer:
    // repositories without a declaration must keep the verdicts they had.
    allows: (from, to) => (LAYER_RANK[from] ?? 0) >= (LAYER_RANK[to] ?? 0),
  };
}

/** Layer names a declaration is allowed to mention. */
export function knownLayerNames(layers: readonly { layer: string }[]): Set<string> {
  return new Set<string>([...BUILTIN_LAYERS, ...layers.map((rule) => rule.layer)]);
}

/**
 * Validate the `order` / `allow` halves of `.anatomia/layers.json`.
 *
 * Throws rather than falling back to the builtin ranking: a broken declaration
 * silently judged by the default order would report violations the repository
 * never asked for (and hide the ones it did).
 */
export function validateLayerDeclaration(
  declaration: { order?: string[]; allow?: Record<string, string[]> },
  layerRules: readonly { layer: string }[],
): void {
  const known = knownLayerNames(layerRules);
  const { order, allow } = declaration;
  if (order) {
    const seen = new Set<string>();
    for (const layer of order) {
      if (!known.has(layer)) throw new Error(`order references undeclared layer "${layer}"`);
      if (seen.has(layer)) throw new Error(`order repeats layer "${layer}"`);
      seen.add(layer);
    }
  }
  if (!allow) return;
  for (const [from, targets] of Object.entries(allow)) {
    if (!known.has(from)) throw new Error(`allow references undeclared layer "${from}"`);
    for (const to of targets) {
      if (!known.has(to)) throw new Error(`allow["${from}"] references undeclared layer "${to}"`);
    }
  }
  // Every layer the repository declares itself must appear as a key: an omitted
  // key would silently mean "may depend on nothing", which is a policy nobody
  // wrote down.
  for (const rule of layerRules) {
    if (!(rule.layer in allow)) throw new Error(`allow is missing declared layer "${rule.layer}"`);
  }
  const cycle = findAllowCycle(allow);
  if (cycle) throw new Error(`allow has a dependency cycle: ${cycle.join(" -> ")}`);
}

/** Depth-first cycle search over `allow` (self-edges are the same layer, not a cycle). */
function findAllowCycle(allow: Record<string, string[]>): string[] | null {
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    if (state.get(node) === "done") return null;
    if (state.get(node) === "open") return [...stack.slice(stack.indexOf(node)), node];
    state.set(node, "open");
    stack.push(node);
    for (const next of allow[node] ?? []) {
      if (next === node) continue;
      const found = visit(next);
      if (found) return found;
    }
    stack.pop();
    state.set(node, "done");
    return null;
  };
  for (const node of Object.keys(allow).sort()) {
    const found = visit(node);
    if (found) return found;
  }
  return null;
}
