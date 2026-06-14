/**
 * T06 — Function hash (= Anchor ID).
 *
 * SHA-256 of the normalized function string, truncated to 16 hex chars
 * (64-bit). Same normalized form → same hash; different structure → different
 * hash; distinct functions → no collision (verified in T10).
 *
 * The hash input is: normalize(body) + "|sig|" + normalizeSignatureShape(body)
 * so that functions whose bodies are structurally identical but differ in
 * parameter or return types get distinct AnchorIds (DESIGN §4.2:
 * "公開シンボル名・型は含める"). Parameter *names* are NOT included (only
 * types), preserving the local-rename invariance property.
 */

import { createHash } from "node:crypto";
import type { AnchorId, FunctionNode } from "../types.js";
import { normalizeSignatureShape } from "./normalize.js";

/** Hash a normalized function string into a 64-bit hex AnchorId. */
export function hashFunction(normalized: string): AnchorId {
  const digest = createHash("sha256").update(normalized, "utf8").digest("hex");
  return digest.slice(0, 16) as AnchorId;
}

/**
 * Fill `FunctionNode.id` in place (and return it) from a normalized body
 * string. The final hash input combines the normalized body with the
 * normalized signature shape (parameter types + return type) so that
 * type-only-differentiated functions get distinct Anchor IDs while
 * parameter renames (same types, different names) still hash identically.
 */
export function assignAnchorId(fn: FunctionNode, normalized: string): AnchorId {
  const sigShape = normalizeSignatureShape(fn.bodyAst);
  const id = hashFunction(normalized + "|sig|" + sigShape);
  fn.id = id;
  return id;
}
