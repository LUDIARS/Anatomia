/**
 * Compatibility entry points for the precise OKF parser.
 */

import type { SpecClause } from "../types.js";
import { parseOkfContent, parseOkfFile, type OkfParserOptions } from "../knowledge/okf-parser.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Produce a URL-safe ASCII slug from arbitrary text. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")   // strip non-word chars (keep - and spaces)
    .trim()
    .replace(/[\s_]+/g, "-")    // spaces/underscores → hyphen
    .replace(/-+/g, "-");       // collapse consecutive hyphens
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse one Markdown file into a flat array of SpecClauses.
 *
 * @param filePath  Absolute path to the .md file to read.
 * @param sourceFile  Relative label stored in SpecClause.sourceFile;
 *                    defaults to filePath when omitted.
 */
export async function parseMdFile(
  filePath: string,
  sourceFile?: string,
  options: OkfParserOptions = {},
): Promise<SpecClause[]> {
  return (await parseOkfFile(filePath, { ...options, sourceFile })).clauses;
}

/** Parse Markdown already downloaded by a trusted adapter without a temporary file. */
export function parseMdText(
  content: string,
  sourceFile: string,
  options: OkfParserOptions = {},
): SpecClause[] {
  return parseOkfContent(content, sourceFile, { ...options, sourceFile }).clauses;
}

/**
 * Parse multiple Markdown files and return a single flat SpecClause[].
 */
export async function parseSpecFiles(paths: string[], options: OkfParserOptions = {}): Promise<SpecClause[]> {
  const results = await Promise.all(paths.map(async (p) => {
    try {
      return await parseMdFile(p, undefined, options);
    } catch (err) {
      // Per-file isolation. The OKF parser fails closed on a document that sits
      // in a typed authoring root with the wrong x-anatomia.kind; with a shared
      // Promise.all that one document rejected the whole batch, and analyze()'s
      // Phase-5 catch then dropped EVERY clause and link in the repository.
      // Skipping the offender keeps it out of the graph (still fail-closed for
      // that document) without zeroing the rest.
      console.warn(`[anatomia/spec] skipped ${p}: ${err instanceof Error ? err.message : String(err)}`);
      return [] as SpecClause[];
    }
  }));
  return results.flat();
}
