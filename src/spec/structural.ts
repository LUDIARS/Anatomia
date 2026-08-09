/**
 * T23 — Structural (naming/placement) heuristic linker.
 * Uses Jaccard word-overlap between clause heading/text keywords and
 * code file path keywords to emit medium-confidence Links.
 *
 * @spec Structural リンク
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

/**
 * Jaccard similarity = |A ∩ B| / |A ∪ B|.
 *
 * Counts the intersection by scanning the SMALLER set and derives the union
 * size arithmetically (|A| + |B| − |A ∩ B|). The set-building form allocated
 * two Sets per (file, clause) pair, i.e. O(files × clauses) short-lived
 * allocations on every analyze — measurable GC pressure on real repos.
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const x of small) if (large.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
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

  // Clause keywords depend only on the clause, so they are derived ONCE here
  // rather than inside the per-file loop below. Re-deriving them per file made
  // this O(files × clauses) full-text tokenisations — on a 531-file repo that
  // was ~half of the entire analyze runtime.
  const clauseKeywords = clauses.map((clause) => ({
    clause,
    keywords: extractKeywords(`${clause.heading} ${clause.text}`),
  }));

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

      for (const { clause, keywords: clauseKw } of clauseKeywords) {
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
