/**
 * T15 — Preset rule catalog.
 *
 * Parameterized factories that each return a concrete Predicate (types.ts ADT).
 * These cover the common 80% of architecture rules without hand-written
 * predicate code (DESIGN §4.3 mode 1, "selection / preset catalog").
 *
 * SRP: this file ONLY builds predicates from parameters; evaluation is the
 * engine's job (engine.ts).
 */

import type { EdgeKind, NodeFilter, Predicate } from "../types.js";

/** Stable preset identifiers (used by domain ontology configs, T18). */
export type PresetId =
  | "layerDependencyDirection"
  | "stateAccessPath"
  | "forbiddenCall"
  | "couplingCap"
  | "noCycle"
  | "hotPathNoAlloc";

/** Build a NodeFilter from a name regex (convenience). */
function byName(pattern: string): NodeFilter {
  return { namePattern: pattern };
}

/**
 * layerDependencyDirection — forbid imports/calls from a higher-index layer to
 * a lower-index layer. Layers are ordered; an edge from layer i to layer j with
 * j < i (i.e. calling "down/backwards") is forbidden.
 *
 * We model each layer by a name pattern (its functions are named/tagged to the
 * layer). For the ordered list [L0, L1, L2], a call from L2 -> L0 or L2 -> L1
 * or L1 -> L0 is forbidden when those are "wrong direction".
 *
 * Convention: layers[0] is the LOWEST (most depended-upon). Higher layers may
 * depend on lower ones, but lower layers must NOT call higher ones.
 * => forbid edges from a lower-index layer to a higher-index layer.
 */
export function layerDependencyDirection(params: {
  layers: string[];
  kind?: EdgeKind;
}): Predicate {
  const kind = params.kind ?? "calls";
  const children: Predicate[] = [];
  const { layers } = params;
  for (let lower = 0; lower < layers.length; lower++) {
    for (let higher = lower + 1; higher < layers.length; higher++) {
      // lower layer must not call higher layer.
      children.push({
        type: "EdgeForbidden",
        from: byName(layers[lower]!),
        to: byName(layers[higher]!),
        kind,
      });
    }
  }
  if (children.length === 1) return children[0]!;
  return { type: "And", children };
}

/**
 * stateAccessPath — state nodes may only be called from allowed callers.
 * Forbids any caller NOT matching allowedCallerPattern from calling a state
 * node. Implemented as: forbid (everything) -> state, AND allow the permitted
 * callers via a Not(forbidden-for-allowed) ... but simpler and precise:
 * we forbid calls into state from callers that do not match the allow pattern.
 *
 * Since the predicate ADT matches by filter, we express the allow-list as a
 * negative caller filter using a regex that excludes the allowed pattern is not
 * generally possible; instead we model it as: forbid calls from ANY caller to
 * state, except we cannot subtract. So we approximate with And/Not:
 *   violation = exists edge (caller -> state) where caller is NOT allowed.
 * We encode "caller is not allowed" by forbidding edges from a broad filter and
 * relying on the allowed pattern being applied at the domain layer. To keep
 * this preset self-contained and precise, we emit an EdgeForbidden from a
 * caller filter that matches everything, wrapped so the engine reports the
 * concrete offending edges; the allowed callers are excluded by a negative
 * lookahead regex baked into the caller name pattern.
 */
export function stateAccessPath(params: {
  statePattern: string;
  allowedCallerPattern: string;
}): Predicate {
  // Caller name must NOT match the allowed pattern: use a negative lookahead.
  const disallowedCaller = `^(?!.*(?:${params.allowedCallerPattern})).*$`;
  return {
    type: "EdgeForbidden",
    from: { namePattern: disallowedCaller },
    to: byName(params.statePattern),
    kind: "calls",
  };
}

/** forbiddenCall — caller must not call callee. */
export function forbiddenCall(params: {
  callerPattern: string;
  calleePattern: string;
  kind?: EdgeKind;
}): Predicate {
  return {
    type: "EdgeForbidden",
    from: byName(params.callerPattern),
    to: byName(params.calleePattern),
    kind: params.kind ?? "calls",
  };
}

/**
 * couplingCap — cap fan-in and/or fan-out on a target set of nodes.
 * Emits a FanInCap and/or FanOutCap; combines with And when both are set.
 */
export function couplingCap(params: {
  targetPattern: string;
  maxFanIn?: number;
  maxFanOut?: number;
  kind?: EdgeKind;
}): Predicate {
  const target = byName(params.targetPattern);
  const children: Predicate[] = [];
  if (params.maxFanIn !== undefined) {
    children.push({ type: "FanInCap", target, max: params.maxFanIn, kind: params.kind });
  }
  if (params.maxFanOut !== undefined) {
    children.push({ type: "FanOutCap", target, max: params.maxFanOut, kind: params.kind });
  }
  if (children.length === 0) {
    throw new Error("couplingCap: specify at least one of maxFanIn / maxFanOut");
  }
  if (children.length === 1) return children[0]!;
  return { type: "And", children };
}

/** noCycle — forbid cycles among nodes matching scopePattern (all if omitted). */
export function noCycle(params: { scopePattern?: string; kind?: EdgeKind } = {}): Predicate {
  const scope: NodeFilter = params.scopePattern ? byName(params.scopePattern) : {};
  return { type: "NoCycle", scope, kind: params.kind };
}

/**
 * hotPathNoAlloc — functions tagged hotPath must not call functions tagged
 * alloc. Expressed as a forbidden calls-edge between tag filters.
 */
export function hotPathNoAlloc(params: {
  hotPathTag: string;
  allocTag: string;
}): Predicate {
  return {
    type: "EdgeForbidden",
    from: { tags: [params.hotPathTag] },
    to: { tags: [params.allocTag] },
    kind: "calls",
  };
}

/**
 * Registry mapping PresetId -> factory, so the ontology loader (T18) can build
 * a predicate from { preset, params } config without a switch at each call
 * site. Params are validated by the individual factories.
 */
export const PRESET_FACTORIES: Record<PresetId, (params: any) => Predicate> = {
  layerDependencyDirection,
  stateAccessPath,
  forbiddenCall,
  couplingCap,
  noCycle,
  hotPathNoAlloc,
};

/** Build a predicate from a preset id + params (used by ontology configs). */
export function buildPresetPredicate(preset: PresetId, params: Record<string, unknown>): Predicate {
  const factory = PRESET_FACTORIES[preset];
  if (!factory) throw new Error(`unknown preset: ${preset}`);
  return factory(params);
}
