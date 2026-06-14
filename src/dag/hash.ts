/**
 * T06 — Function hash (= Anchor ID).
 *
 * SHA-256 of the normalized function string, truncated to 16 hex chars
 * (64-bit). Same normalized form → same hash; different structure → different
 * hash; distinct functions → no collision (verified in T10).
 */

import { createHash } from "node:crypto";
import type { AnchorId, FunctionNode } from "../types.js";

/** Hash a normalized function string into a 64-bit hex AnchorId. */
export function hashFunction(normalized: string): AnchorId {
  const digest = createHash("sha256").update(normalized, "utf8").digest("hex");
  return digest.slice(0, 16) as AnchorId;
}

/**
 * Fill `FunctionNode.id` in place (and return it) from a normalized string.
 * Convenience for the extract → normalize → hash pipeline.
 */
export function assignAnchorId(fn: FunctionNode, normalized: string): AnchorId {
  const id = hashFunction(normalized);
  fn.id = id;
  return id;
}
