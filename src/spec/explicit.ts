/**
 * T22 — Explicit annotation linker.
 * Scans code files for @implements / @spec annotations and spec text for
 * code file references.  Emits Link[] with evidence "explicit".
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { AnchorId, Link, SpecClause } from "../types.js";

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

/** @implements SPEC-xxx */
const RE_IMPLEMENTS = /@implements\s+(SPEC-\S+)/g;
/** @spec <text> — heading reference */
const RE_SPEC = /@spec\s+(.+)/g;

/**
 * Joins clause texts into one searchable corpus used only as a PREFILTER.
 *
 * A name present in some clause is necessarily present in the join, whatever
 * the separator, so the prefilter can never produce a false negative — the
 * property correctness rests on. A match straddling the join is possible and
 * merely costs one exact per-clause scan that then finds nothing.
 */
const CLAUSE_SEPARATOR = "\n";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFileAnchor(filePath: string): AnchorId {
  return filePath as unknown as AnchorId;
}

/**
 * Clauses whose chosen field CONTAINS a needle, answered without rescanning
 * every clause each time.
 *
 * All three matchers here are the same shape: a needle taken from the code side
 * (an @implements ref, an @spec heading ref, a file basename) tested against one
 * field of every clause. Run directly that is `needles × clauses` substring
 * searches per file — the dominant cost of this linker on a repo with thousands
 * of clauses. Two observations remove it without changing a single link:
 *
 *  - Most needles match NO clause. One search over the joined corpus settles
 *    that for the whole spec at once, so the per-clause loop runs only for
 *    needles that really do appear somewhere.
 *  - The answer depends only on the needle, and needles repeat heavily across
 *    files (a shared basename like `index.ts`, the same @spec heading cited from
 *    several modules), so it is memoised.
 */
class ClauseFieldIndex {
  private readonly corpus: string;
  private readonly cache = new Map<string, SpecClause[]>();

  constructor(
    private readonly clauses: SpecClause[],
    private readonly field: (clause: SpecClause) => string,
  ) {
    this.corpus = clauses.map(field).join(CLAUSE_SEPARATOR);
  }

  matching(needle: string): SpecClause[] {
    const memoised = this.cache.get(needle);
    if (memoised) return memoised;
    const found = this.corpus.includes(needle)
      ? this.clauses.filter((clause) => this.field(clause).includes(needle))
      : [];
    this.cache.set(needle, found);
    return found;
  }
}

/** The three clause indexes one findExplicitLinks call needs. */
interface ClauseIndexes {
  byId: ClauseFieldIndex;
  byHeading: ClauseFieldIndex;
  byText: ClauseFieldIndex;
}

function buildClauseIndexes(clauses: SpecClause[]): ClauseIndexes {
  return {
    byId: new ClauseFieldIndex(clauses, (clause) => clause.id),
    byHeading: new ClauseFieldIndex(clauses, (clause) => clause.heading),
    byText: new ClauseFieldIndex(clauses, (clause) => clause.text),
  };
}

function linksTo(clauses: SpecClause[], filePath: string): Link[] {
  return clauses.map((clause) => ({
    from: makeFileAnchor(filePath),
    to: clause.id,
    confidence: 1.0,
    evidence: "explicit" as const,
  }));
}

function matchImplements(
  text: string,
  indexes: ClauseIndexes,
  filePath: string,
): Link[] {
  const links: Link[] = [];
  for (const m of text.matchAll(RE_IMPLEMENTS)) {
    const specRef = m[1]; // e.g. "SPEC-abc123"
    // `id === specRef` is subsumed by `id.includes(specRef)`.
    links.push(...linksTo(indexes.byId.matching(specRef), filePath));
  }
  return links;
}

function matchSpecAnnotation(
  text: string,
  indexes: ClauseIndexes,
  filePath: string,
): Link[] {
  const links: Link[] = [];
  for (const m of text.matchAll(RE_SPEC)) {
    const ref = m[1].trim(); // e.g. "§4.5" or "some heading text"
    links.push(...linksTo(indexes.byHeading.matching(ref), filePath));
  }
  return links;
}

function matchSpecTextForFile(indexes: ClauseIndexes, filePath: string): Link[] {
  const base = basename(filePath); // e.g. "hash.ts"
  return linksTo(indexes.byText.matching(base), filePath);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find all explicit links between spec clauses and code files.
 *
 * Scans:
 *  1. Code files for @implements SPEC-xxx annotations.
 *  2. Code files for @spec <heading-text> annotations.
 *  3. Spec clause text for references to code file basenames.
 */
export async function findExplicitLinks(
  clauses: SpecClause[],
  codeFiles: string[],
): Promise<Link[]> {
  const links: Link[] = [];
  const indexes = buildClauseIndexes(clauses);

  await Promise.all(
    codeFiles.map(async (filePath) => {
      let text = "";
      try {
        text = await readFile(filePath, "utf8");
      } catch {
        // Unreadable file — skip code-side scanning but still check spec text.
      }

      if (text) {
        links.push(...matchImplements(text, indexes, filePath));
        links.push(...matchSpecAnnotation(text, indexes, filePath));
      }

      links.push(...matchSpecTextForFile(indexes, filePath));
    }),
  );

  return links;
}
