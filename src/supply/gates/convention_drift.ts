/**
 * T29 gate 5 — convention_drift (WARN).
 *
 * Flags changed functions whose naming/idiom diverges from sibling code
 * (DESIGN §9.1 ③ "命名/イディオムが兄弟から乖離"). We mine two cheap, structural
 * conventions from the siblings and check the new code against them:
 *
 *   1. Naming case style: derive the dominant style (camelCase / PascalCase /
 *      snake_case) among siblings; a changed name in a different style drifts.
 *   2. Common affixes: derive shared prefixes/suffixes (e.g. all siblings end in
 *      "Transition"); a changed name lacking the dominant affix drifts.
 *
 * No LLM, no embeddings — purely structural so it is deterministic and cheap.
 *
 * SRP: convention mining + name comparison only.
 */

import type { AnchorId, GateResult } from "../../types.js";
import type { Gate, DiffInput } from "./types.js";

type CaseStyle = "camel" | "pascal" | "snake" | "other";

function caseStyle(name: string): CaseStyle {
  if (/^[a-z][a-zA-Z0-9]*$/.test(name) && /[A-Z]/.test(name)) return "camel";
  if (/^[a-z][a-z0-9]*$/.test(name)) return "camel"; // all-lowercase = camel family
  if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) return "pascal";
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(name)) return "snake";
  return "other";
}

/** Dominant value in a list (mode); ties resolved by sorted order. */
function dominant<T extends string>(values: T[]): T | null {
  if (values.length === 0) return null;
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) =>
    b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
  )[0]![0];
}

/** A suffix shared by ALL sibling names (longest common camel/Pascal word). */
function commonSuffix(names: string[]): string | null {
  if (names.length < 2) return null;
  // Split each name into trailing PascalCase/snake word and check unanimity.
  const tails = names.map((n) => {
    const camel = n.match(/[A-Z][a-z0-9]*$/);
    if (camel) return camel[0];
    const snake = n.match(/_([a-z0-9]+)$/);
    if (snake) return snake[1]!;
    return "";
  });
  const first = tails[0];
  if (!first) return null;
  return tails.every((t) => t === first) ? first : null;
}

export function conventionDriftGate(): Gate {
  return {
    name: "convention_drift",
    severity: "warn",
    async run(input: DiffInput): Promise<GateResult> {
      const siblings = (input.siblings ?? []).filter((f) => f.id !== null);
      const changed = input.changed.filter((f) => f.id !== null);

      // No siblings = no local convention to drift from.
      if (siblings.length === 0 || changed.length === 0) {
        return { gate: "convention_drift", pass: true, anchors: [], suggestion: null };
      }

      const sibNames = siblings.map((f) => f.name);
      const domStyle = dominant(sibNames.map(caseStyle));
      const sharedSuffix = commonSuffix(sibNames);

      const drifts: { anchor: AnchorId; reason: string }[] = [];
      for (const fn of changed) {
        const reasons: string[] = [];
        if (domStyle && domStyle !== "other") {
          const style = caseStyle(fn.name);
          if (style !== domStyle && style !== "other") {
            reasons.push(`naming style ${style} ≠ sibling ${domStyle}`);
          }
        }
        if (sharedSuffix && !fn.name.endsWith(sharedSuffix)) {
          reasons.push(`missing common suffix "${sharedSuffix}"`);
        }
        if (reasons.length > 0) {
          drifts.push({ anchor: fn.id!, reason: `${fn.name}: ${reasons.join("; ")}` });
        }
      }

      const pass = drifts.length === 0;
      return {
        gate: "convention_drift",
        pass,
        anchors: [...new Set(drifts.map((d) => d.anchor))].sort() as GateResult["anchors"],
        suggestion: pass
          ? null
          : "Naming/idiom diverges from siblings:\n" +
            drifts.map((d) => `  - ${d.reason}`).sort().join("\n"),
      };
    },
  };
}

export const _internal = { caseStyle, dominant, commonSuffix };

