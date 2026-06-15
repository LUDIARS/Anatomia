/**
 * T45 — Frame → deterministic phase signature (trace compression, DESIGN §5.5).
 *
 * A phase signature discretizes one frame into a small, stable descriptor: the
 * SET of active domains (optionally the top-k by time share) plus the hottest
 * domain. Because the domain count is tiny (a handful), distinct signatures are
 * naturally bounded and the signature id = sha256(canonical descriptor) is
 * content-addressed — no clustering randomness, so the same trace always yields
 * the same phase ids. This keeps the dynamic side cache-safe in exactly the way
 * the static side is (DESIGN §4.6 "embedding-RAG を核にしない" / §9 cache).
 *
 * SRP: this file ONLY maps a StitchedFrame to a PhaseSignature. Discovery,
 * FSM induction, labeling and classification live in sibling files.
 */
import { createHash } from "node:crypto";
import type { StitchedFrame } from "../stitch.js";

export interface PhaseSignature {
  /** Content-addressed id = sha256 over the canonical descriptor. */
  id: string;
  /** Sorted set of (top-k) active domain names. */
  domains: string[];
  /** Domain of the hottest zone this frame, or null. */
  hotDomain: string | null;
}

export interface SignatureOptions {
  /**
   * Keep only the top-k domains by time share as the signature's domain set.
   * 0 / undefined = keep ALL active domains. A lower k yields coarser phases.
   */
  topK?: number;
  /**
   * Fold the hottest domain into the id (default true). Set false to make
   * phases depend only on WHICH domains are active, not which is hottest.
   */
  useHotDomain?: boolean;
}

/** Deterministic string comparator (ascending, byte order). */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compute a deterministic phase signature for a single stitched frame.
 */
export function frameSignature(
  frame: StitchedFrame,
  options: SignatureOptions = {},
): PhaseSignature {
  const useHot = options.useHotDomain ?? true;
  let domains = [...frame.activeDomains];

  // Top-k by accumulated domain time (desc), tie-break by name (asc) so the
  // selection is deterministic for equal times.
  if (options.topK && options.topK > 0 && domains.length > options.topK) {
    domains = domains
      .sort((a, b) => {
        const ta = frame.domainTimes[a] ?? 0;
        const tb = frame.domainTimes[b] ?? 0;
        return tb !== ta ? tb - ta : cmpStr(a, b);
      })
      .slice(0, options.topK);
  }

  domains.sort(cmpStr);

  // hotZone.domain is '' when the hot anchor has no card; normalise to null.
  const hotDomain = useHot ? frame.hotZone?.domain || null : null;

  const canonical = JSON.stringify({ domains, hot: hotDomain });
  const id = createHash("sha256").update(canonical, "utf8").digest("hex");

  return { id, domains, hotDomain };
}

/** Jaccard similarity over two domain sets. Two empty sets are identical (1). */
export function domainSetJaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 1 : inter / union;
}
