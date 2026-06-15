/**
 * T28 — Supply bundle assembly (DESIGN §9.1 ① + §9).
 *
 * Assembles the 6 elements of a clean-context bundle:
 *   landingAnchor, applicableRules, specClauses, exemplars, impactRadius,
 *   existingDomains.
 *
 * Determinism (the contract): same input -> byte-identical bundle. Guaranteed by
 *   1. stable sorting EVERY collection (rules by id, clauses by id, exemplars by
 *      anchor, impact by anchor, domains by name);
 *   2. the landing anchor being a single content-addressed AnchorId (Merkle
 *      hash) chosen deterministically by the caller (T27);
 *   3. the bundle's own content key = merkleHash over the sorted landing anchors,
 *      so the bundle is content-addressed (DESIGN §9 "キー = 着地点アンカーの
 *      Merkle ハッシュ").
 *
 * Order: immutable-first / mutable-last is enforced by `orderBundleSegments`,
 * mirroring @ludiars/llm-gateway `orderSegments` (immutable: domain summaries,
 * spec clauses, type/rule defs; mutable: the current query/landing). We keep the
 * structured ContextBundle (types.ts) and additionally expose a flat ordered
 * segment list for the gateway.
 *
 * SRP: pure assembly + ordering + content key. No graph access, no LLM, no I/O.
 */

import { createHash } from "node:crypto";
import type {
  AnchorId,
  ContextBundle,
  FunctionNode,
  Rule,
  SpecClause,
} from "../types.js";

/** Inputs to assembleBundle. All collections may be unsorted; we sort. */
export interface BundleInputs {
  /** Landing anchors resolved by T27. The FIRST (after sort) becomes the
   *  bundle's landingAnchor; ALL are folded into the content key. */
  landingAnchors: AnchorId[];
  /** global ∪ domain rules (G3). */
  rules: Rule[];
  /** Spec clauses linked to the landing (G4). */
  specClauses: SpecClause[];
  /** Sibling exemplar functions defining local conventions. */
  exemplars: FunctionNode[];
  /** KG-derived anchors that could be affected (impact radius). */
  impactRadius: AnchorId[];
  /** Existing domains that subsume this task (duplication guard). */
  existingDomains: string[];
}

/** A content-addressed bundle: the ContextBundle plus its Merkle content key. */
export interface AddressedBundle {
  bundle: ContextBundle;
  /** Merkle content key = sha256 over the sorted landing anchors. */
  contentKey: string;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Stable de-dup + sort for a string-keyed list. */
function uniqSortBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of [...items].sort((a, b) => cmpStr(key(a), key(b)))) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/**
 * Content key over the landing anchors (which ARE function content hashes).
 * Sorted so the key is order-independent; SHA-256 hex (matches DAG hashing).
 */
export function bundleContentKey(landingAnchors: AnchorId[]): string {
  const sorted = [...new Set(landingAnchors)].sort();
  return createHash("sha256").update(sorted.join("\n"), "utf8").digest("hex");
}

/**
 * Assemble a deterministic ContextBundle. Same input -> byte-identical output.
 */
export function assembleBundle(inputs: BundleInputs): AddressedBundle {
  const landingAnchors = [...new Set(inputs.landingAnchors)].sort();
  const landingAnchor = landingAnchors.length > 0 ? landingAnchors[0]! : null;

  const applicableRules = uniqSortBy(inputs.rules, (r) => r.id);
  const specClauses = uniqSortBy(inputs.specClauses, (c) => c.id);
  // Exemplars keyed by anchor id (skip null-id functions for determinism).
  const exemplars = uniqSortBy(
    inputs.exemplars.filter((f) => f.id !== null),
    (f) => f.id as string,
  );
  const impactRadius = [...new Set(inputs.impactRadius)].sort();
  const existingDomains = [...new Set(inputs.existingDomains)].sort(cmpStr);

  const bundle: ContextBundle = {
    landingAnchor,
    applicableRules,
    specClauses,
    exemplars,
    impactRadius,
    existingDomains,
  };

  return { bundle, contentKey: bundleContentKey(landingAnchors) };
}

// ── Ordered segments (immutable-first / mutable-last) ───────────────────────

/** A flat text segment for the llm-gateway ordering convention. */
export interface BundleSegment {
  kind: "domains" | "rules" | "spec" | "exemplars" | "impact" | "landing";
  /** True = stable across the repo (immutable); placed BEFORE mutable. */
  immutable: boolean;
  text: string;
}

/**
 * Flatten a ContextBundle into ordered segments: immutable-first, mutable-last.
 * This mirrors @ludiars/llm-gateway orderSegments so the prefix is stable and
 * cache_read can hit. The order within each tier is fixed and deterministic.
 */
export function orderBundleSegments(bundle: ContextBundle): BundleSegment[] {
  const segs: BundleSegment[] = [];

  // ── Immutable tier (stable repo facts) ─────────────────────────────────────
  segs.push({
    kind: "domains",
    immutable: true,
    text:
      "Existing domains (do not reinvent): " +
      (bundle.existingDomains.join(", ") || "(none)"),
  });
  segs.push({
    kind: "rules",
    immutable: true,
    text:
      "Applicable rules:\n" +
      (bundle.applicableRules
        .map((r) => `  - [${r.severity}] ${r.id}: ${r.description}`)
        .join("\n") || "  (none)"),
  });
  segs.push({
    kind: "spec",
    immutable: true,
    text:
      "Spec clauses:\n" +
      (bundle.specClauses
        .map((c) => `  - ${c.id} (${c.heading})`)
        .join("\n") || "  (none)"),
  });
  segs.push({
    kind: "exemplars",
    immutable: true,
    text:
      "Sibling exemplars:\n" +
      (bundle.exemplars
        .map((f) => `  - ${f.name} [anchor=${f.id}]`)
        .join("\n") || "  (none)"),
  });

  // ── Mutable tier (this task's specifics) ───────────────────────────────────
  segs.push({
    kind: "impact",
    immutable: false,
    text: "Impact radius: " + (bundle.impactRadius.join(", ") || "(none)"),
  });
  segs.push({
    kind: "landing",
    immutable: false,
    text: "Landing anchor: " + (bundle.landingAnchor ?? "(novel — propose)"),
  });

  return segs;
}
