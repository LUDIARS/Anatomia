/**
 * T21 — Markdown spec parser.
 * Parses spec/*.md files into SpecClause[] using a line-by-line approach.
 * No external dependencies beyond Node built-ins.
 */

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { SpecClause } from "../types.js";

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

/** Parse an ATX heading line.  Returns { level, text } or null. */
function parseHeading(line: string): { level: number; text: string } | null {
  const m = line.match(/^(#{1,6})\s+(.*)/);
  if (!m) return null;
  return { level: m[1].length, text: m[2].trim() };
}

/** Build §-style heading path from a stack of heading texts per level. */
function buildHeadingPath(stack: (string | null)[]): string {
  return stack
    .filter((s): s is string => s !== null && s !== "")
    .join(" / ");
}

/**
 * Deterministic clause ID.
 * sha256(sourceFile + "::" + headingPath).slice(0, 8) prefixed by slug.
 */
function makeClauseId(sourceFile: string, headingPath: string): string {
  const raw = `${sourceFile}::${headingPath}`;
  const digest = createHash("sha256").update(raw, "utf8").digest("hex");
  const prefix = slugify(headingPath).slice(0, 24) || "root";
  return `${prefix}-${digest.slice(0, 8)}`;
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
): Promise<SpecClause[]> {
  const src = sourceFile ?? filePath;
  const content = await readFile(filePath, "utf8");
  const lines = content.split(/\r?\n/);

  const clauses: SpecClause[] = [];

  // Heading stack indexed 1..6 (index 0 unused).
  const headingStack: (string | null)[] = [null, null, null, null, null, null, null];
  let currentHeadingPath = "";
  let currentTextLines: string[] = [];

  function flushClause(): void {
    if (!currentHeadingPath) return; // pre-document text before any heading
    const text = currentTextLines.join("\n").trim();
    const id = makeClauseId(src, currentHeadingPath);
    clauses.push({
      id,
      sourceFile: src,
      heading: currentHeadingPath,
      text,
      embedding: null,
    });
  }

  for (const line of lines) {
    const heading = parseHeading(line);
    if (heading) {
      // Flush the previous clause.
      flushClause();

      // Update the heading stack.
      headingStack[heading.level] = heading.text;
      // Clear deeper levels.
      for (let d = heading.level + 1; d <= 6; d++) {
        headingStack[d] = null;
      }

      currentHeadingPath = buildHeadingPath(headingStack.slice(1));
      currentTextLines = [];
    } else {
      currentTextLines.push(line);
    }
  }

  // Flush the final clause.
  flushClause();

  return clauses;
}

/**
 * Parse multiple Markdown files and return a single flat SpecClause[].
 */
export async function parseSpecFiles(paths: string[]): Promise<SpecClause[]> {
  const results = await Promise.all(paths.map((p) => parseMdFile(p)));
  return results.flat();
}
