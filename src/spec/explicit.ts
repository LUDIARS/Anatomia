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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFileAnchor(filePath: string): AnchorId {
  return filePath as unknown as AnchorId;
}

function matchImplements(
  text: string,
  clauses: SpecClause[],
  filePath: string,
): Link[] {
  const links: Link[] = [];
  for (const m of text.matchAll(RE_IMPLEMENTS)) {
    const specRef = m[1]; // e.g. "SPEC-abc123"
    for (const clause of clauses) {
      if (clause.id.includes(specRef) || clause.id === specRef) {
        links.push({
          from: makeFileAnchor(filePath),
          to: clause.id,
          confidence: 1.0,
          evidence: "explicit",
        });
      }
    }
  }
  return links;
}

function matchSpecAnnotation(
  text: string,
  clauses: SpecClause[],
  filePath: string,
): Link[] {
  const links: Link[] = [];
  for (const m of text.matchAll(RE_SPEC)) {
    const ref = m[1].trim(); // e.g. "§4.5" or "some heading text"
    for (const clause of clauses) {
      if (clause.heading.includes(ref)) {
        links.push({
          from: makeFileAnchor(filePath),
          to: clause.id,
          confidence: 1.0,
          evidence: "explicit",
        });
      }
    }
  }
  return links;
}

function matchSpecTextForFile(
  clauses: SpecClause[],
  filePath: string,
): Link[] {
  const links: Link[] = [];
  const base = basename(filePath); // e.g. "hash.ts"
  for (const clause of clauses) {
    if (clause.text.includes(base)) {
      links.push({
        from: makeFileAnchor(filePath),
        to: clause.id,
        confidence: 1.0,
        evidence: "explicit",
      });
    }
  }
  return links;
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

  await Promise.all(
    codeFiles.map(async (filePath) => {
      let text = "";
      try {
        text = await readFile(filePath, "utf8");
      } catch {
        // Unreadable file — skip code-side scanning but still check spec text.
      }

      if (text) {
        links.push(...matchImplements(text, clauses, filePath));
        links.push(...matchSpecAnnotation(text, clauses, filePath));
      }

      links.push(...matchSpecTextForFile(clauses, filePath));
    }),
  );

  return links;
}
