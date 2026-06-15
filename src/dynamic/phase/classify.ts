/**
 * T49 — Online phase classification (the live "you-are-here" phase, §5.5/§6).
 *
 * Given the current frame — and optionally a debounce window of recent frames —
 * compute its signature and resolve it to a learned phase id via a prebuilt
 * PhaseModel. A majority vote over the window suppresses single-frame flicker.
 * This is what fills where.ts's previously-null `phase`, taking the live cursor
 * down from domain/function to phase level.
 *
 * Unknown frames (a signature never seen in training) resolve to null unless a
 * `nearestThreshold` fallback is given, in which case the closest phase by
 * domain-set Jaccard above the threshold is returned.
 *
 * SRP: this file ONLY maps live frame(s) → phase id using a PhaseModel; it does
 * not learn (discover.ts) or name (label.ts) phases.
 */
import type { StitchedFrame } from "../stitch.js";
import type { PhaseModel } from "./discover.js";
import { frameSignature, domainSetJaccard, type SignatureOptions } from "./signature.js";

export interface ClassifyOptions {
  /**
   * Signature options. Defaults to the model's stored options so the live
   * signature is computed exactly as at discovery (pass to override).
   */
  signature?: SignatureOptions;
  /**
   * Fallback for unknown signatures: match the nearest phase by domain-set
   * Jaccard ≥ this threshold. Omit / ≤ 0 = no fallback (unknown ⇒ null).
   */
  nearestThreshold?: number;
}

export interface PhaseClassifier {
  /** Resolve a single frame to a phase id, or null if unknown. */
  classifyFrame(frame: StitchedFrame): string | null;
  /** Majority-vote a window of frames (most-recent-wins on ties), or null. */
  classifyWindow(frames: StitchedFrame[]): string | null;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build a classifier bound to a learned PhaseModel.
 */
export function buildClassifier(
  model: PhaseModel,
  options: ClassifyOptions = {},
): PhaseClassifier {
  const sigOpts = options.signature ?? model.signatureOptions ?? {};
  const near = options.nearestThreshold ?? 0;

  const sigToPhase = new Map<string, string>();
  for (const p of model.phases) {
    for (const sid of p.memberSignatureIds) sigToPhase.set(sid, p.id);
  }

  function classifyFrame(frame: StitchedFrame): string | null {
    const s = frameSignature(frame, sigOpts);
    const exact = sigToPhase.get(s.id);
    if (exact !== undefined) return exact;

    if (near > 0) {
      let best: string | null = null;
      let bestScore = -1;
      // Phases are pre-sorted (count desc, id asc); iterate in that order and
      // keep the strictly-better score so ties resolve to the earlier (more
      // frequent / lexicographically smaller) phase deterministically.
      for (const p of model.phases) {
        const score = domainSetJaccard(s.domains, p.signature.domains);
        if (score >= near && score > bestScore) {
          best = p.id;
          bestScore = score;
        }
      }
      return best;
    }
    return null;
  }

  function classifyWindow(frames: StitchedFrame[]): string | null {
    const votes = new Map<string, number>();
    let lastId: string | null = null;
    for (const f of frames) {
      const id = classifyFrame(f);
      if (id !== null) {
        votes.set(id, (votes.get(id) ?? 0) + 1);
        lastId = id;
      }
    }
    if (votes.size === 0) return null;

    const maxC = Math.max(...votes.values());
    const top = [...votes.keys()].filter((id) => votes.get(id) === maxC);
    // Tie-break: prefer the most recently seen, else lexicographically smallest.
    if (lastId !== null && top.includes(lastId)) return lastId;
    return top.sort(cmpStr)[0] ?? null;
  }

  return { classifyFrame, classifyWindow };
}
