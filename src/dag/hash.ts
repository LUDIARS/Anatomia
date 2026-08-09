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
 * The implementation also folds a location scope into the hash input so
 * same-shaped internal functions in different files remain distinct graph nodes.
 * analyze() supplies the repo-relative path, keeping IDs stable across worktrees.
 */

import { createHash } from "node:crypto";
import type { AnchorId, FunctionNode } from "../types.js";
import { normalizeSignatureShape } from "./normalize.js";
import { normalizeSlashes } from "../fs/repo-path.js";

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
export function assignAnchorId(
  fn: FunctionNode,
  normalized: string,
  locationScope?: string,
): AnchorId {
  const sigShape = normalizeSignatureShape(fn.bodyAst);
  fn.signatureShape = sigShape;
  // Path-independent structural hash: same body+signature → same hash regardless
  // of file. Identifies structural clones (the file is added below for `id`).
  fn.structuralHash = hashFunction(normalized + "|sig|" + sigShape);
  // Callers that know the repo root pass the REPO-RELATIVE path, so the same
  // commit checked out at two places (a repo and a Revisor PR-review worktree)
  // produces the same anchors — without it every worktree invents a private ID
  // space, which is why cross-checkout reuse was impossible and why anchors
  // cited in one review never resolved in another. Callers with no repo context
  // (a raw diff snippet) fall back to whatever path the node carries.
  const scope = normalizeSlashes(locationScope ?? fn.sourceRange.filePath);
  const id = hashFunction(normalized + "|sig|" + sigShape + "|file|" + scope);
  fn.id = id;
  return id;
}
