/**
 * T29 gate 2 — duplication (BLOCK).
 *
 * New code must not be TOO similar to an existing mechanic card — that signals
 * reinventing a mechanic (DESIGN: "AI 最大の不潔源"). This is the ONE place
 * embedding is used as a *flag* (DESIGN §9.1 ③ "ここだけ embedding を*フラグ*に").
 *
 * The embedding client is INJECTED (DuplicationDeps.embed) and mocked in tests —
 * no real API. We embed the changed functions' signatures+names and each
 * existing mechanic card's text, then cosine-compare. Max similarity above the
 * threshold fails the gate, naming the duplicated mechanic.
 *
 * SRP: similarity scoring + thresholding only.
 */

import type { GateResult } from "../../types.js";
import type { Gate, DiffInput, DuplicationDeps } from "./types.js";
import { changedAnchors } from "./types.js";

const DEFAULT_SIMILARITY = 0.85;

/** Cosine similarity between two equal-length vectors. */
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Stable text summary of the changed code (deterministic ordering). */
function changedText(input: DiffInput): string {
  return [...input.changed]
    .filter((f) => f.id !== null)
    .sort((a, b) => (a.id! < b.id! ? -1 : a.id! > b.id! ? 1 : 0))
    .map((f) => `${f.name} ${f.signature}`)
    .join("\n");
}

export function duplicationGate(deps: DuplicationDeps): Gate {
  const threshold = deps.similarityThreshold ?? DEFAULT_SIMILARITY;
  return {
    name: "duplication",
    severity: "block",
    async run(input: DiffInput): Promise<GateResult> {
      const cards = input.mechanicCards ?? [];
      const anchors = changedAnchors(input).sort();

      if (cards.length === 0) {
        return { gate: "duplication", pass: true, anchors: [], suggestion: null };
      }

      const newText = changedText(input);
      // Single embed call: [newText, ...cardTexts] — deterministic order.
      const cardTexts = [...cards]
        .sort((a, b) => (a.mechanic < b.mechanic ? -1 : a.mechanic > b.mechanic ? 1 : 0))
        .map((c) => c.text);
      const sortedCards = [...cards].sort((a, b) =>
        a.mechanic < b.mechanic ? -1 : a.mechanic > b.mechanic ? 1 : 0,
      );
      const vectors = await deps.embed([newText, ...cardTexts]);
      const newVec = vectors[0];
      if (!newVec) {
        return { gate: "duplication", pass: true, anchors: [], suggestion: null };
      }

      let worst = -1;
      let worstMechanic = "";
      for (let i = 0; i < sortedCards.length; i++) {
        const v = vectors[i + 1];
        if (!v) continue;
        const sim = cosine(newVec, v);
        if (sim > worst) {
          worst = sim;
          worstMechanic = sortedCards[i]!.mechanic;
        }
      }

      const pass = worst < threshold;
      return {
        gate: "duplication",
        pass,
        anchors: pass ? [] : (anchors as GateResult["anchors"]),
        suggestion: pass
          ? null
          : `New code is ${(worst * 100).toFixed(0)}% similar to existing mechanic "${worstMechanic}" (threshold ${(threshold * 100).toFixed(0)}%). Extend the existing mechanic instead of reimplementing it.`,
      };
    },
  };
}
