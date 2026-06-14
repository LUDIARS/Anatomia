/**
 * T29 gate 3 — spec_linkage (WARN -> BLOCK).
 *
 * New code should link to a spec clause (G4). Orphans (no spec link) are
 * flagged. Severity is escalatable: by default this gate WARNS, but when
 * `strict` is set it BLOCKS (DESIGN §9.1 table: "warn→block").
 *
 * A changed function is "linked" when some Link's `from` equals its anchor.
 * (G4 links use file-path or anchor `from`; we match on anchor first, then on
 * the function's source file path as a fallback, matching the G4 file-anchor
 * convention used by the explicit/structural/semantic linkers.)
 *
 * SRP: orphan detection over injected links only; no linking is performed here.
 */

import type { AnchorId, GateResult } from "../../types.js";
import type { Gate, DiffInput } from "./types.js";

export function specLinkageGate(strict = false): Gate {
  return {
    name: "spec_linkage",
    severity: strict ? "block" : "warn",
    async run(input: DiffInput): Promise<GateResult> {
      const links = input.links ?? [];
      const linkedFrom = new Set(links.map((l) => l.from));

      const orphans: { anchor: AnchorId; name: string }[] = [];
      for (const fn of input.changed) {
        if (fn.id === null) continue;
        const byAnchor = linkedFrom.has(fn.id);
        const byFile = linkedFrom.has(fn.sourceRange.filePath as unknown as AnchorId);
        if (!byAnchor && !byFile) {
          orphans.push({ anchor: fn.id, name: fn.name });
        }
      }

      const pass = orphans.length === 0;
      const anchors = orphans
        .map((o) => o.anchor)
        .sort() as GateResult["anchors"];
      return {
        gate: "spec_linkage",
        pass,
        anchors,
        suggestion: pass
          ? null
          : "Orphan code (no spec link). Link to a spec clause via @implements SPEC-xxx or add a spec clause:\n" +
            orphans
              .map((o) => `  - ${o.name} [anchor=${o.anchor}]`)
              .sort()
              .join("\n"),
      };
    },
  };
}
