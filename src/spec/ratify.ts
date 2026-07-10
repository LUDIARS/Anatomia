/**
 * src/spec/ratify.ts — the ratification path shared by CLI and web adapters.
 *
 * Takes a (from anchor, to clause-id) pair, validates the clause against the
 * current analysis (fail-fast on a typo'd id — a committed decision must point
 * at a real clause), promotes the matching proposed link via harden.ratify()
 * (or records a fresh explicit link when the linkers never proposed the pair —
 * a human decree outranks the heuristics), and appends it to the committed
 * artifact through persist.ts.
 *
 * SRP: validate + promote + persist orchestration only. Promotion semantics
 * in harden.ts; file IO in persist.ts; HTTP/CLI shaping in the adapters.
 */

import type { AnchorId, Link, SpecClause } from "../types.js";
import { ratify, mergeLinks } from "./harden.js";
import { loadRatifiedLinks, saveRatifiedLinks } from "./persist.js";

/** Validation failure (unknown clause / bad input) — adapters map this to 400. */
export class SpecLinkRatifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecLinkRatifyError";
  }
}

export interface RatifyLinkRequest {
  /** Repo root that owns spec/data/spec-links.json. */
  repoRoot: string;
  /** Code anchor or file path (the Link `from` side). */
  from: string;
  /** Spec clause id (the Link `to` side). */
  to: string;
  /** Current analysis links — a matching proposal is promoted in place. */
  links: Link[];
  /** Current analysis clauses — `to` must resolve to one of these. */
  specClauses: SpecClause[];
}

export interface RatifyLinkResult {
  /** The ratified link as persisted (explicit / 1.0 / ratified). */
  link: Link;
  /** Absolute path of the written artifact. */
  path: string;
  /** True when the pair was already proposed by a linker (vs a fresh decree). */
  wasProposed: boolean;
}

/**
 * Ratify one (from, to) pair and append it to the committed artifact.
 * Throws SpecLinkRatifyError when `to` is not a known clause id.
 */
export async function ratifyLink(req: RatifyLinkRequest): Promise<RatifyLinkResult> {
  if (!req.from || !req.to) {
    throw new SpecLinkRatifyError("ratify requires both a from anchor and a to clause id");
  }
  const clause = req.specClauses.find((cl) => cl.id === req.to);
  if (!clause) {
    throw new SpecLinkRatifyError(
      `no such spec clause "${req.to}" — ratification must target a clause from the current analysis`,
    );
  }

  const proposal = req.links.find(
    (l) => String(l.from) === req.from && l.to === req.to,
  );
  const link = ratify(
    proposal ?? {
      from: req.from as unknown as AnchorId,
      to: req.to,
      confidence: 1.0,
      evidence: "explicit",
    },
  );

  // Append into the existing set; mergeLinks dedups an already-ratified pair.
  const existing = await loadRatifiedLinks(req.repoRoot);
  const merged = mergeLinks([...existing, link]);
  const path = await saveRatifiedLinks(req.repoRoot, merged);
  return { link, path, wasProposed: proposal !== undefined };
}
