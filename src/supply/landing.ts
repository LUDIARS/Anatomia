/**
 * T27 — Landing-point decision (DESIGN §9.1.1).
 *
 * landing = f(domain category, layer rules, existing siblings).
 *
 *   novel task -> resolve domain (semantics) -> architectural layer (layer
 *   rules) -> pin a concrete location via existing sibling functions.
 *
 * Three cases:
 *   - precedent exists (siblings found)  -> deterministic, high confidence,
 *     anchor = the chosen sibling's anchor.
 *   - novel domain (no siblings)       -> layer is known, concrete location is
 *     a *proposal*; lower confidence; anchor = null.
 *   - cross-cutting task (multiple
 *     domains resolved)                -> decompose by domain and return one
 *     landing per domain.
 *
 * SRP: this file ONLY resolves landing points. Domain resolution, layer rules
 * and sibling lookup are injected interfaces (reuse G3 detection + ontology).
 */

import type { AnchorId } from "../types.js";

/** A task to find a landing point for. */
export interface LandingTask {
  /** Free-text task description (used by the domain detector). */
  description: string;
  /** Optional explicit domain hints; if given, detector may be skipped. */
  domainHints?: string[];
}

/**
 * Resolve which domain(s) a task belongs to. Returns domain names in a
 * STABLE order. Reuses G3 domain ontology/detection; injected so landing has
 * no hard dependency on a concrete detector (mockable in tests).
 */
export type DomainDetector = (task: LandingTask) => Promise<string[]>;

/**
 * Map a domain name to its architectural layer (DESIGN §4.3 / §9.1.1).
 * Returns null when the domain maps to no known layer (still novel).
 */
export interface LayerRules {
  layerFor(domain: string): string | null;
}

/** A sibling = an existing function that implements the same domain. */
export interface Sibling {
  anchor: AnchorId;
  name: string;
  /** Layer this sibling lives in (for proposal text / filtering). */
  layer: string | null;
  /**
   * How many call sites reference this sibling. A heavily-referenced function
   * is the one the repo actually treats as the pattern; optional so hand-built
   * siblings (tests, external callers) may omit it (counted as 0).
   */
  references?: number;
}

/**
 * Sibling lookup for a (domain, layer). Returns siblings in a STABLE,
 * caller-defined order; resolveLanding picks the first as the precedent anchor.
 */
export type SiblingLookup = (domain: string, layer: string | null) => Promise<Sibling[]>;

/** One resolved landing point. */
export interface Landing {
  /** The domain this landing is for. */
  domain: string;
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

/**
 * Layer preference for the precedent pick, most-exemplary first. A repo's own
 * `src` / `app` / `samples` code is what a new implementation should imitate;
 * vendored code is present but is nobody's convention.
 */
const LAYER_PRIORITY: readonly string[] = ["src", "app", "samples", "sample", "examples", "example"];

/** Layers that are copied-in third-party code — never a precedent to imitate. */
const VENDOR_LAYERS: ReadonlySet<string> = new Set([
  "third_party",
  "thirdparty",
  "3rdparty",
  "vendor",
  "vendors",
  "extern",
  "external",
  "deps",
  "node_modules",
]);

/** Lower rank = better precedent. Unknown layers sit between preferred and vendor. */
function layerRank(layer: string | null): number {
  if (layer === null) return LAYER_PRIORITY.length + 1;
  const normalized = layer.toLowerCase();
  const preferred = LAYER_PRIORITY.indexOf(normalized);
  if (preferred !== -1) return preferred;
  if (VENDOR_LAYERS.has(normalized)) return LAYER_PRIORITY.length + 2;
  return LAYER_PRIORITY.length + 1;
}

/**
 * Choose the sibling a new implementation should be modelled on: the repo's own
 * layers before vendored code, then the most-referenced function, then anchor
 * order as the deterministic tie-break.
 *
 * Anchor order ALONE (the previous rule) picked whichever content hash sorted
 * first, which is meaningless as a design signal — Figmentum's `kirie-transform`
 * landed on `third_party/stb_image.h`, telling the author to imitate a vendored
 * header. Every component of this comparison is derived from the analysed repo,
 * so the pick stays deterministic.
 */
export function pickPrecedent(siblings: Sibling[]): Sibling | undefined {
  if (siblings.length === 0) return undefined;
  return [...siblings].sort((a, b) => {
    const rank = layerRank(a.layer) - layerRank(b.layer);
    if (rank !== 0) return rank;
    const refs = (b.references ?? 0) - (a.references ?? 0);
    if (refs !== 0) return refs;
    if (a.anchor !== b.anchor) return a.anchor < b.anchor ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  })[0];
}

/**
 * Resolve landing point(s) for a task.
 *
 * @returns one Landing per resolved domain, ordered by domain name
 *          (deterministic). Cross-cutting tasks produce multiple entries.
 */
export async function resolveLanding(
  task: LandingTask,
  detector: DomainDetector,
  layerRules: LayerRules,
  siblings: SiblingLookup,
): Promise<Landing[]> {
  const domains =
    task.domainHints && task.domainHints.length > 0
      ? [...new Set(task.domainHints)]
      : [...new Set(await detector(task))];

  // Deterministic domain order.
  domains.sort();

  const landings: Landing[] = [];
  for (const domain of domains) {
    const layer = layerRules.layerFor(domain);
    const sibs = await siblings(domain, layer);
    const precedent = pickPrecedent(sibs);

    if (precedent) {
      // Deterministic landing: pin to the precedent sibling.
      landings.push({
        domain,
        anchor: precedent.anchor,
        layer: precedent.layer ?? layer,
        confidence: CONF_PRECEDENT,
      });
    } else if (layer) {
      // Layer known but no precedent -> propose a concrete location.
      landings.push({
        domain,
        anchor: null,
        layer,
        confidence: CONF_LAYER_ONLY,
        proposal: `No existing sibling for domain "${domain}"; create it in layer "${layer}". This choice becomes the precedent (hardening).`,
      });
    } else {
      // Fully novel: neither sibling nor layer.
      landings.push({
        domain,
        anchor: null,
        layer: null,
        confidence: CONF_NOVEL,
        proposal: `Novel domain "${domain}": no layer rule and no sibling. Decide a layer first, then a location; the decision hardens into precedent.`,
      });
    }
  }

  return landings;
}
