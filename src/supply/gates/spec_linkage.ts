/**
 * T29 gate 3 — spec_linkage (WARN -> BLOCK).
 *
 * New code should link to a spec clause (G4). Orphans (no spec link at all)
 * are flagged. Severity is escalatable: by default this gate WARNS, but when
 * `strict` is set it BLOCKS (DESIGN §9.1 table: "warn→block").
 *
 * Linkage is confidence-aware: a link only counts as real linkage when its
 * confidence reaches `minConfidence`. Functions whose links exist but ALL sit
 * below the threshold are a SEPARATE advisory category — "weakly linked", not
 * orphaned: they never fail the gate (even in strict mode a low-confidence
 * heuristic guess must not block a merge), but the suggestion calls them out
 * distinctly so the hardening loop (ratify / @implements) can firm them up.
 * `minConfidence` defaults to 0 in normal mode (exact legacy behaviour: any
 * link counts) and 0.5 in strict mode; an explicit 0 always restores the
 * legacy behaviour.
 *
 * A changed function is "linked" when some Link's `from` equals its anchor.
 * (G4 links use file-path or anchor `from`; we match on anchor first, then on
 * the function's source file path as a fallback, matching the G4 file-anchor
 * convention used by the explicit/structural/semantic linkers.)
 *
 * SRP: orphan/weak-link detection over injected links only; no linking here.
 */

import type { AnchorId, GateResult } from "../../types.js";
import type { Gate, DiffInput } from "./types.js";

/** Default confidence floor applied in strict mode when none is given. */
const STRICT_DEFAULT_MIN_CONFIDENCE = 0.5;

export interface SpecLinkageOptions {
  /**
   * Minimum link confidence that counts as real linkage. Links below it mark
   * their function "weakly linked" (advisory, never blocking). Default: 0 in
   * normal mode (legacy: any link counts), 0.5 in strict mode.
   */
  minConfidence?: number;
}

export function specLinkageGate(
  strict = false,
  options: SpecLinkageOptions = {},
): Gate {
  const minConfidence =
    options.minConfidence ?? (strict ? STRICT_DEFAULT_MIN_CONFIDENCE : 0);
  return {
    name: "spec_linkage",
    severity: strict ? "block" : "warn",
    async run(input: DiffInput): Promise<GateResult> {
      const links = input.links ?? [];
      // Best confidence per `from` key (anchor or file path).
      const bestByFrom = new Map<string, number>();
      for (const l of links) {
        const key = String(l.from);
        const prev = bestByFrom.get(key);
        if (prev === undefined || l.confidence > prev) bestByFrom.set(key, l.confidence);
      }

      const orphans: { anchor: AnchorId; name: string }[] = [];
      const weak: { anchor: AnchorId; name: string; best: number }[] = [];
      for (const fn of input.changed) {
        if (fn.id === null) continue;
        const byAnchor = bestByFrom.get(String(fn.id));
        const byFile = bestByFrom.get(String(fn.sourceRange.filePath));
        const best =
          byAnchor === undefined
            ? byFile
            : byFile === undefined
              ? byAnchor
              : Math.max(byAnchor, byFile);
        if (best === undefined) {
          orphans.push({ anchor: fn.id, name: fn.name });
        } else if (best < minConfidence) {
          weak.push({ anchor: fn.id, name: fn.name, best });
        }
      }

      // Only true orphans fail the gate; weak links are advisory in any mode.
      const pass = orphans.length === 0;
      const anchors = [...orphans, ...weak]
        .map((o) => o.anchor)
        .sort() as GateResult["anchors"];

      const parts: string[] = [];
      if (orphans.length > 0) {
        parts.push(
          "Orphan code (no spec link). Link to a spec clause via @implements SPEC-xxx or add a spec clause:\n" +
            orphans
              .map((o) => `  - ${o.name} [anchor=${o.anchor}]`)
              .sort()
              .join("\n"),
        );
      }
      if (weak.length > 0) {
        parts.push(
          `Weakly-linked code (links exist but all below confidence ${minConfidence}). ` +
            "Not an orphan — harden the link (ratify it via `anatomia links ratify` or annotate @implements SPEC-xxx):\n" +
            weak
              .map((w) => `  - ${w.name} [anchor=${w.anchor}, best=${w.best.toFixed(2)}]`)
              .sort()
              .join("\n"),
        );
      }

      return {
        gate: "spec_linkage",
        pass,
        anchors,
        suggestion: parts.length > 0 ? parts.join("\n") : null,
      };
    },
  };
}
