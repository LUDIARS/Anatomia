/**
 * src/graph/override-dispatch.ts — overrides reachable through a base method.
 *
 * Static resolution binds `this.active.onBody(…)` to the BASE method it can see
 * (`Scene.onBody`), never to the subclass overrides — fanning a call out to
 * every same-named override would manufacture phantom cross-layer edges
 * (type-resolve.ts header). The overrides therefore had no static caller and a
 * scene's whole lifecycle (`init` / `enter` / `frame` / `onBody` / …, delivered
 * by a scene manager) was reported as dead code (Ludellus PR #1757).
 *
 * This module does not add call edges. It records, per override, WHY it may be
 * reached at run time, so review can keep it out of the "no static caller" list
 * while still saying the reachability is inferred:
 *
 *   - "base-call"       : a resolved call edge reaches the overridden base method;
 *   - "abstract-call"   : a call was dropped because its receiver's static type
 *                         (this type or an ancestor) has no body for the method;
 *   - "unresolved-call" : a member call of that name exists whose receiver could
 *                         not be typed. Weakest form — kept only for overrides,
 *                         i.e. methods that implement a declared base contract.
 *
 * A method that overrides nothing never gets evidence here, so a genuinely
 * unused helper stays an orphan.
 *
 * SRP: derive dispatch evidence from a built graph. Reporting lives in review/.
 *
 * @spec Override dispatch evidence
 */

import type { AnchorId } from "../types.js";
import type { CodeGraph } from "./build.js";

export type DispatchVia = "base-call" | "abstract-call" | "unresolved-call";

export interface DispatchEvidence {
  /** The override that may be dispatched to. */
  target: AnchorId;
  /**
   * The base definition it overrides, when the base has a body. Null for an
   * interface/abstract contract (the dropped call's receiver type is named on
   * the record instead).
   */
  base: AnchorId | null;
  /** For "abstract-call": the static receiver type of the dropped call. */
  receiverType?: string;
  via: DispatchVia;
}

/** Strength order: a resolved base call beats an abstract drop beats an untyped call. */
const VIA_RANK: Record<DispatchVia, number> = { "base-call": 0, "abstract-call": 1, "unresolved-call": 2 };

export function resolveOverrideDispatch(graph: CodeGraph): DispatchEvidence[] {
  const registry = graph.typeRegistry;
  if (!registry) return [];

  const untypedCallNames = new Set<string>();
  const abstractDrops: { name: string; receiverType: string }[] = [];
  for (const drop of graph.unresolved ?? []) {
    if (drop.reason === "unresolved-receiver") untypedCallNames.add(drop.calleeName);
    if (drop.reason === "abstract-no-impl" && drop.receiverType) {
      abstractDrops.push({ name: drop.calleeName, receiverType: drop.receiverType });
    }
  }
  const hasIncomingCall = (id: AnchorId): boolean =>
    (graph.reverseAdjacency.get(id) ?? []).some((edge) => edge.kind === "calls" && edge.from !== id);

  const best = new Map<AnchorId, DispatchEvidence>();
  const offer = (evidence: DispatchEvidence): void => {
    const current = best.get(evidence.target);
    if (!current || VIA_RANK[evidence.via] < VIA_RANK[current.via]) best.set(evidence.target, evidence);
  };

  for (const { type, method, id } of registry.methodDefinitions()) {
    const bases = registry.overriddenBy(type, method);
    const called = bases.find(hasIncomingCall);
    if (called) {
      offer({ target: id, base: called, via: "base-call" });
      continue;
    }
    // The call went through an interface/abstract type the method's class
    // implements — the dependency-inversion drop type-resolve.ts makes on purpose.
    const abstract = abstractDrops.find((drop) =>
      drop.name === method && drop.receiverType !== type && registry.isSelfOrAncestor(type, drop.receiverType));
    if (abstract) {
      offer({ target: id, base: bases[0] ?? null, via: "abstract-call", receiverType: abstract.receiverType });
      continue;
    }
    if (bases.length > 0 && untypedCallNames.has(method)) {
      offer({ target: id, base: bases[0]!, via: "unresolved-call" });
    }
  }

  return [...best.values()].sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
}
