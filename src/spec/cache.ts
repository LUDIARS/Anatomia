/**
 * src/spec/cache.ts — content-addressed cache for Phase 5 spec linking.
 *
 * analyze() Phase 5 (parseSpecFiles + findExplicitLinks + findStructuralLinks)
 * re-reads every source file to scan for @implements / exported symbols, so it
 * re-runs in full on every fingerprint MISS — including a code-only edit that
 * left the spec untouched, and (on a warm server) every re-analysis of an
 * unchanged project whose fingerprint was busted by config. Keying the linked
 * result by what it actually depends on lets that path reuse it.
 *
 * The linkers' output depends on: the spec files' CONTENT (clauses + basename
 * references), and the source files' PATH + CONTENT (@implements/@spec live in
 * comments; structural links use path + exported names). So the key folds the
 * spec files' path + raw-content hash and each source FileNode's path +
 * contentHash (raw source SHA-256 — NOT the structural Merkle hash, which is
 * comment-blind and would serve stale links after an annotation edit).
 *
 * In-process only: clauses/links are plain JS shared by reference, mirroring
 * graph/cache.ts. SRP: key derivation + cache type only; lookup at call site.
 */

import { createHash } from "node:crypto";
import { versionedKey, type CacheStore } from "../cache/store.js";
import type { FileNode, Link, SpecClause } from "../types.js";

/** BUMP when the linkers' semantics or SpecLinkResult's shape change. */
export const SPEC_LINK_CACHE_VERSION = "1";

/** A spec file's identity for keying: absolute path + raw content. */
export interface SpecFileContent {
  path: string;
  content: string;
}

/** The whole Phase-5 output, cached as one unit. */
export interface SpecLinkResult {
  specClauses: SpecClause[];
  links: Link[];
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Content identity of the spec-linking inputs: spec files (path + content
 * hash) and source files (path + raw content hash), each sorted so ordering
 * never perturbs the key.
 */
export function specLinkContentKey(
  specFiles: SpecFileContent[],
  sourceFiles: FileNode[],
): string {
  const specStamps = specFiles
    .map((f) => `${f.path.replace(/\\/g, "/")}\0${sha256(f.content)}`)
    .sort();
  const sourceStamps = sourceFiles
    .map((f) => `${f.path.replace(/\\/g, "/")}\0${f.contentHash ?? f.hash ?? ""}`)
    .sort();
  return sha256(`${specStamps.join("\n")}\n\0\n${sourceStamps.join("\n")}`);
}

/** Cache key for the spec-link result over `specFiles` × `sourceFiles`. */
export function specLinkCacheKey(
  specFiles: SpecFileContent[],
  sourceFiles: FileNode[],
): string {
  return versionedKey(
    specLinkContentKey(specFiles, sourceFiles),
    "spec-link",
    SPEC_LINK_CACHE_VERSION,
  );
}

/** Content-addressed store for spec-link results (in-process). */
export type SpecLinkCache = CacheStore<SpecLinkResult>;
