/**
 * T27 — Landing-point decision (DESIGN §9.1.1).
 *
 * landing = f(mechanic category, layer rules, existing siblings).
 *
 *   novel task -> resolve mechanic (semantics) -> architectural layer (layer
 *   rules) -> pin a concrete location via existing sibling functions.
 *
 * Three cases:
 *   - precedent exists (siblings found)  -> deterministic, high confidence,
 *     anchor = the chosen sibling's anchor.
 *   - novel mechanic (no siblings)       -> layer is known, concrete location is
 *     a *proposal*; lower confidence; anchor = null.
 *   - cross-cutting task (multiple
 *     mechanics resolved)                -> decompose by mechanic and return one
 *     landing per mechanic.
 *
 * SRP: this file ONLY resolves landing points. Mechanic resolution, layer rules
 * and sibling lookup are injected interfaces (reuse G3 detection + ontology).
 */

import type { AnchorId } from "../types.js";

/** A task to find a landing point for. */
export interface LandingTask {
  /** Free-text task description (used by the mechanic detector). */
  description: string;
  /** Optional explicit mechanic hints; if given, detector may be skipped. */
  mechanicHints?: string[];
}

/**
 * Resolve which mechanic(s) a task belongs to. Returns mechanic names in a
 * STABLE order. Reuses G3 mechanic ontology/detection; injected so landing has
 * no hard dependency on a concrete detector (mockable in tests).
 */
export type MechanicDetector = (task: LandingTask) => Promise<string[]>;

/**
 * Map a mechanic name to its architectural layer (DESIGN §4.3 / §9.1.1).
 * Returns null when the mechanic maps to no known layer (still novel).
 */
export interface LayerRules {
  layerFor(mechanic: string): string | null;
}

/** A sibling = an existing function that implements the same mechanic. */
export interface Sibling {
  anchor: AnchorId;
  name: string;
  /** Layer this sibling lives in (for proposal text / filtering). */
  layer: string | null;
}

/**
 * Sibling lookup for a (mechanic, layer). Returns siblings in a STABLE,
 * caller-defined order; resolveLanding picks the first as the precedent anchor.
 */
export type SiblingLookup = (mechanic: string, layer: string | null) => Promise<Sibling[]>;

/** One resolved landing point. */
export interface Landing {
  /** The mechanic this landing is for. */
  mechanic: string;
  /** Concrete anchor when a precedent exists; null for a novel proposal. */
  anchor: AnchorId | null;
  /** Architectural layer (may be null if no layer rule matched). */
  layer: string | null;
  /** 0.0–1.0 confidence. Precedent => high; novel => low. */
  confidence: number;
  /** Human-readable proposal when no precedent (concrete location is a guess). */
  proposal?: string;
}

// Confidence constants (documented, tunable).
const CONF_PRECEDENT = 0.9; // sibling exists -> deterministic
const CONF_LAYER_ONLY = 0.5; // layer known, no sibling -> proposal
const CONF_NOVEL = 0.25; // no layer, no sibling -> fully novel

/** Stable sort helper for siblings by anchor then name (deterministic pick). */
function pickPrecedent(siblings: Sibling[]): Sibling | undefined {
  if (siblings.length === 0) return undefined;
  return [...siblings].sort((a, b) => {
    if (a.anchor !== b.anchor) return a.anchor < b.anchor ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  })[0];
}

/**
 * Resolve landing point(s) for a task.
 *
 * @returns one Landing per resolved mechanic, ordered by mechanic name
 *          (deterministic). Cross-cutting tasks produce multiple entries.
 */
export async function resolveLanding(
  task: LandingTask,
  detector: MechanicDetector,
  layerRules: LayerRules,
  siblings: SiblingLookup,
): Promise<Landing[]> {
  const mechanics =
    task.mechanicHints && task.mechanicHints.length > 0
      ? [...new Set(task.mechanicHints)]
      : [...new Set(await detector(task))];

  // Deterministic mechanic order.
  mechanics.sort();

  const landings: Landing[] = [];
  for (const mechanic of mechanics) {
    const layer = layerRules.layerFor(mechanic);
    const sibs = await siblings(mechanic, layer);
    const precedent = pickPrecedent(sibs);

    if (precedent) {
      // Deterministic landing: pin to the precedent sibling.
      landings.push({
        mechanic,
        anchor: precedent.anchor,
        layer: precedent.layer ?? layer,
        confidence: CONF_PRECEDENT,
      });
    } else if (layer) {
      // Layer known but no precedent -> propose a concrete location.
      landings.push({
        mechanic,
        anchor: null,
        layer,
        confidence: CONF_LAYER_ONLY,
        proposal: `No existing sibling for mechanic "${mechanic}"; create it in layer "${layer}". This choice becomes the precedent (hardening).`,
      });
    } else {
      // Fully novel: neither sibling nor layer.
      landings.push({
        mechanic,
        anchor: null,
        layer: null,
        confidence: CONF_NOVEL,
        proposal: `Novel mechanic "${mechanic}": no layer rule and no sibling. Decide a layer first, then a location; the decision hardens into precedent.`,
      });
    }
  }

  return landings;
}
