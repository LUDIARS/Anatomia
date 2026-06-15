/**
 * T46 — Phase discovery (offline vocabulary, DESIGN §5.5).
 *
 * Over a window of recorded frames, collect the DISTINCT phase signatures =
 * the learned set of phases. Optionally MERGE near-identical signatures whose
 * domain sets exceed a FIXED Jaccard threshold (the only clustering we allow —
 * deterministic, no random init, no K to choose). Frequency counts become the
 * confidence / dead-phase signal downstream.
 *
 * Determinism: signatures are content-addressed (signature.ts); distinct
 * signatures are processed in a fixed order (count desc, id asc); the merge is
 * greedy against that order, so the same frames always produce the same model.
 *
 * SRP: this file ONLY builds the phase set + per-frame phase-id assignment.
 * FSM dynamics is fsm.ts; labeling is label.ts; live lookup is classify.ts.
 */
import type { StitchedFrame } from "../stitch.js";
import {
  frameSignature,
  domainSetJaccard,
  type PhaseSignature,
  type SignatureOptions,
} from "./signature.js";

/** A learned phase = a representative signature + the frames/signatures it owns. */
export interface Phase {
  /** Stable phase id = the representative (most frequent) signature id. */
  id: string;
  /** Representative signature. */
  signature: PhaseSignature;
  /** Number of frames assigned to this phase. */
  frameCount: number;
  /** Signature ids folded into this phase (sorted, includes the representative). */
  memberSignatureIds: string[];
}

export interface PhaseModel {
  /** Learned phases, sorted by frameCount desc then id asc. */
  phases: Phase[];
  /** Per input frame (in order): the assigned phase id. */
  framePhaseIds: string[];
  /** Signature options used — stored so classify.ts can reproduce them. */
  signatureOptions: SignatureOptions;
}

export interface DiscoverOptions {
  signature?: SignatureOptions;
  /**
   * Jaccard threshold in [0,1] for merging signatures by domain-set overlap.
   * >= 1 (default) = no merge: only exact-signature equality groups frames.
   * e.g. 0.7 merges signatures sharing ≥70% of their domains.
   */
  mergeThreshold?: number;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface DistinctSig {
  sig: PhaseSignature;
  count: number;
}

interface PhaseAcc {
  rep: PhaseSignature;
  members: DistinctSig[];
  count: number;
}

/**
 * Discover the phase vocabulary from a window of stitched frames.
 */
export function discoverPhases(
  frames: StitchedFrame[],
  options: DiscoverOptions = {},
): PhaseModel {
  const sigOpts = options.signature ?? {};
  const merge = options.mergeThreshold ?? 1;

  const sigs = frames.map((f) => frameSignature(f, sigOpts));

  // Group frames by exact signature id.
  const byId = new Map<string, DistinctSig>();
  for (const s of sigs) {
    const e = byId.get(s.id);
    if (e) e.count++;
    else byId.set(s.id, { sig: s, count: 1 });
  }

  // Fixed processing order: most frequent first, ties by id (deterministic).
  const distinct = [...byId.values()].sort(
    (a, b) => b.count - a.count || cmpStr(a.sig.id, b.sig.id),
  );

  // Greedy phase accumulation. With merge >= 1, each distinct signature is its
  // own phase; otherwise a signature joins the first phase within threshold.
  const accs: PhaseAcc[] = [];
  for (const d of distinct) {
    let placed = false;
    if (merge < 1) {
      for (const p of accs) {
        if (domainSetJaccard(d.sig.domains, p.rep.domains) >= merge) {
          p.members.push(d);
          p.count += d.count;
          placed = true;
          break;
        }
      }
    }
    if (!placed) accs.push({ rep: d.sig, members: [d], count: d.count });
  }

  // Map every signature id to its owning phase id.
  const sigToPhase = new Map<string, string>();
  for (const p of accs) {
    for (const m of p.members) sigToPhase.set(m.sig.id, p.rep.id);
  }

  const phases: Phase[] = accs
    .map((p) => ({
      id: p.rep.id,
      signature: p.rep,
      frameCount: p.count,
      memberSignatureIds: p.members.map((m) => m.sig.id).sort(cmpStr),
    }))
    .sort((a, b) => b.frameCount - a.frameCount || cmpStr(a.id, b.id));

  const framePhaseIds = sigs.map((s) => sigToPhase.get(s.id)!);

  return { phases, framePhaseIds, signatureOptions: sigOpts };
}
