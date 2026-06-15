/**
 * T10 — Hash hit-rate measurement harness.
 *
 * Given a corpus of C++ function-pair cases, MEASURE how well normalization
 * achieves the DESIGN goal:
 *   same-meaning edits (formatting / comment / local-rename) -> SAME hash
 *   structure edits (different logic)                        -> DIFFERENT hash
 *   distinct functions                                       -> no collision
 *
 * Metrics (DESIGN §14 / §4.2):
 *   falseInvalidationRate = (same-meaning pairs that wrongly differ) /
 *                           (total same-meaning pairs)
 *   falseCollisionRate    = (distinct-function pairs that share a hash) /
 *                           (all distinct pairs)
 */

import type { Lang, FunctionNode } from "../types.js";
import { parse } from "./parser.js";
import { extractFunctions } from "./extract.js";
import { normalize } from "./normalize.js";
import { assignAnchorId } from "./hash.js";

/** Hash the FIRST top-level function found in a C++ snippet. */
export async function hashSnippet(source: string, lang: Lang = "cpp"): Promise<string> {
  const tree = await parse(source, lang);
  try {
    const fns = extractFunctions(tree, source);
    if (fns.length === 0) throw new Error("no function found in snippet");
    const fn = fns[0]!;
    return assignAnchorId(fn, normalize(fn.bodyAst));
  } finally {
    tree.delete();
  }
}

// ---------------------------------------------------------------------------
// AST-aware perturbation (T44 measurement harness, shared by both scripts).
//
// The naive `str.replace("{", ...)` perturbation breaks on TypeScript:
//   1. object-type return annotations (`function f(): { a: number } {}`) put a
//      `{` BEFORE the body, so the probe lands in the type annotation;
//   2. re-parsing a sliced snippet standalone makes `extractFunctions(...)[0]`
//      return an INNER arrow function instead of the outer method.
//
// These helpers locate the function body via the AST (the body subtree's byte
// range) and re-identify the SAME function by name (outermost match), so the
// probe always lands inside the real body and the hash compared is the right
// function's. Works for C++ / C# / TypeScript alike.
// ---------------------------------------------------------------------------

/**
 * Pick the function to measure among the extracted functions.
 *
 * When `name` is given, candidates are the same-named functions in SOURCE
 * ORDER; `occurrence` (0-based) selects which one — so multiple functions that
 * share a name within one file (overloaded constructors, repeated getters) are
 * disambiguated stably across whitespace/comment perturbations (which never add
 * or remove functions). When `occurrence` is omitted, the outermost (earliest)
 * candidate is returned. When `name` is omitted, the outermost function overall
 * is returned (avoids an inner arrow/local that a standalone re-parse surfaces).
 */
export function pickFunction(
  fns: FunctionNode[],
  name?: string,
  occurrence?: number,
): FunctionNode | null {
  const candidates = (name ? fns.filter((f) => f.name === name) : fns).slice();
  if (candidates.length === 0) return null;
  // Source order: by start line, then column.
  candidates.sort((a, b) => {
    const as = a.sourceRange.start;
    const bs = b.sourceRange.start;
    return as.line - bs.line || as.column - bs.column;
  });
  if (occurrence !== undefined) {
    return candidates[occurrence] ?? null;
  }
  return candidates[0] ?? null;
}

/**
 * Insert a comment probe INSIDE the body of the selected function (just after
 * the body block's opening brace), located via the AST body subtree — NOT via a
 * naive first-`{` scan (which would land in an object-type return annotation).
 *
 * Returns the perturbed source, or null when the target function / body cannot
 * be located. A comment is a same-meaning edit: the hash MUST stay the same.
 */
export async function insertBodyComment(
  source: string,
  lang: Lang,
  name?: string,
  occurrence?: number,
  comment = "/* anatomia-probe */",
): Promise<string | null> {
  const tree = await parse(source, lang);
  try {
    const fns = extractFunctions(tree, source);
    const fn = pickFunction(fns, name, occurrence);
    if (!fn) return null;
    // bodyAst is the compound_statement / statement_block; its first byte is `{`.
    const body = fn.bodyAst;
    const insertAt = body.startIndex + 1; // right after the opening brace
    if (insertAt <= 0 || insertAt > source.length) return null;
    return source.slice(0, insertAt) + " " + comment + " " + source.slice(insertAt);
  } finally {
    tree.delete();
  }
}

/**
 * Hash a snippet by selecting the SAME function (by name + occurrence, or
 * outermost) the measurement is about, rather than blindly taking
 * `extractFunctions(...)[0]`. `filePath` is folded into the AnchorId (hash.ts)
 * so it MUST match the path the stored hash was computed with for a meaningful
 * comparison. Returns null when the target function is not found.
 */
export async function hashNamedSnippet(
  source: string,
  lang: Lang,
  name?: string,
  filePath = "<memory>",
  occurrence?: number,
): Promise<string | null> {
  const tree = await parse(source, lang);
  try {
    const fns = extractFunctions(tree, source, filePath);
    const fn = pickFunction(fns, name, occurrence);
    if (!fn) return null;
    return assignAnchorId(fn, normalize(fn.bodyAst));
  } finally {
    tree.delete();
  }
}

export interface SameMeaningCase {
  category: "formatting" | "comment" | "local_rename";
  name: string;
  base: string;
  variant: string;
}

export interface StructureCase {
  name: string;
  base: string;
  variant: string;
}

export interface CategoryReport {
  category: string;
  total: number;
  /** Cases that behaved as expected. */
  ok: number;
  /** Cases that behaved wrongly (same-meaning -> differ, or struct -> same). */
  wrong: number;
}

export interface MeasureReport {
  /** (same-meaning -> wrongly different) / total same-meaning. */
  falseInvalidationRate: number;
  /** colliding distinct pairs / all distinct pairs. */
  falseCollisionRate: number;
  /** structure edits that wrongly produced the SAME hash. */
  missedStructureChanges: number;
  perCategory: CategoryReport[];
  totalSameMeaning: number;
  totalDistinct: number;
  collisions: Array<[string, string]>;
}

/**
 * Run the measurement over the provided corpus.
 *
 * @param sameMeaning pairs that MUST hash identically
 * @param structure   pairs that MUST hash differently (logic changed)
 * @param distinct    a set of distinct functions; no two may share a hash
 */
export async function measureCorpus(
  sameMeaning: SameMeaningCase[],
  structure: StructureCase[],
  distinct: { name: string; source: string }[],
): Promise<MeasureReport> {
  const perCategory = new Map<string, CategoryReport>();
  const bump = (cat: string, ok: boolean) => {
    let rep = perCategory.get(cat);
    if (!rep) {
      rep = { category: cat, total: 0, ok: 0, wrong: 0 };
      perCategory.set(cat, rep);
    }
    rep.total += 1;
    if (ok) rep.ok += 1;
    else rep.wrong += 1;
  };

  // Same-meaning: expect equal hashes.
  let falseInvalidations = 0;
  for (const c of sameMeaning) {
    const h1 = await hashSnippet(c.base);
    const h2 = await hashSnippet(c.variant);
    const ok = h1 === h2;
    if (!ok) falseInvalidations += 1;
    bump(c.category, ok);
  }

  // Structure: expect different hashes.
  let missedStructureChanges = 0;
  for (const c of structure) {
    const h1 = await hashSnippet(c.base);
    const h2 = await hashSnippet(c.variant);
    const ok = h1 !== h2;
    if (!ok) missedStructureChanges += 1;
    bump("body_change", ok);
  }

  // Distinct: no two may share a hash.
  const hashes = new Map<string, string>(); // hash -> first owner name
  const collisions: Array<[string, string]> = [];
  for (const d of distinct) {
    const h = await hashSnippet(d.source);
    const owner = hashes.get(h);
    if (owner) collisions.push([owner, d.name]);
    else hashes.set(h, d.name);
  }
  const n = distinct.length;
  const totalDistinctPairs = (n * (n - 1)) / 2;

  return {
    falseInvalidationRate:
      sameMeaning.length === 0 ? 0 : falseInvalidations / sameMeaning.length,
    falseCollisionRate:
      totalDistinctPairs === 0 ? 0 : collisions.length / totalDistinctPairs,
    missedStructureChanges,
    perCategory: [...perCategory.values()],
    totalSameMeaning: sameMeaning.length,
    totalDistinct: n,
    collisions,
  };
}
