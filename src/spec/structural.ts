/**
 * T23 — Structural (naming/placement) heuristic linker.
 * Uses Jaccard word-overlap between clause heading/text keywords and
 * code file path keywords to emit medium-confidence Links.
 */

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { AnchorId, Link, SpecClause } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_SCORE = 0.1;
const CONFIDENCE_BASE = 0.4;
const CONFIDENCE_SCALE = 0.4;
const CONFIDENCE_MAX = 0.8;

/** Common English words that provide no signal. */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "in", "on", "at", "to", "for",
  "is", "it", "be", "as", "by", "we", "do", "so", "if", "no", "not",
  "this", "that", "with", "from", "are", "was", "has", "have", "had",
  "can", "will", "may", "each", "all", "any", "its", "use", "used",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFileAnchor(filePath: string): AnchorId {
  return filePath as unknown as AnchorId;
}

/** Extract meaningful lowercase keywords from a blob of text. */
function extractKeywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s\-_./\(),;:'"!?<>[\]{}|]+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w)),
  );
}

/** Extract keywords from a code file path. */
function filePathKeywords(filePath: string): Set<string> {
  const base = basename(filePath, extname(filePath)); // e.g. "hash" from "hash.ts"
  return extractKeywords(base);
}

/** Jaccard similarity = |A ∩ B| / |A ∪ B|. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}

/**
 * Extract exported symbol names from source text.
 * Looks for: export function X, export class X, export const X
 */
function extractExportedNames(text: string): string[] {
  const names: string[] = [];
  const re = /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  for (const m of text.matchAll(re)) {
    names.push(m[1].toLowerCase());
  }
  return names;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find structural links using Jaccard word-overlap heuristics.
 *
 * Also considers exported symbol names from code files.
 * Emits Links with evidence "structural" and confidence in [0.4, 0.8].
 */
export async function findStructuralLinks(
  clauses: SpecClause[],
  codeFiles: string[],
): Promise<Link[]> {
  const links: Link[] = [];

  await Promise.all(
    codeFiles.map(async (filePath) => {
      // Keywords from file path/name.
      const pathKw = filePathKeywords(filePath);

      // Try to read file for exported symbol names.
      let exportedKw = new Set<string>();
      try {
        const text = await readFile(filePath, "utf8");
        const names = extractExportedNames(text);
        exportedKw = new Set(names.flatMap((n) => [...extractKeywords(n)]));
      } catch {
        // Ignore unreadable files.
      }

      const fileKw = new Set([...pathKw, ...exportedKw]);

      for (const clause of clauses) {
        const clauseKw = extractKeywords(`${clause.heading} ${clause.text}`);

        const score = jaccard(fileKw, clauseKw);
        if (score >= MIN_SCORE) {
          const confidence = Math.min(
            CONFIDENCE_BASE + score * CONFIDENCE_SCALE,
            CONFIDENCE_MAX,
          );
          links.push({
            from: makeFileAnchor(filePath),
            to: clause.id,
            confidence,
            evidence: "structural",
          });
        }
      }
    }),
  );

  return links;
}
