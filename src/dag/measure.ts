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

import type { Lang } from "../types.js";
import { parse } from "./parser.js";
import { extractFunctions } from "./extract.js";
import { normalize } from "./normalize.js";
import { hashFunction } from "./hash.js";

/** Hash the FIRST top-level function found in a C++ snippet. */
export async function hashSnippet(source: string, lang: Lang = "cpp"): Promise<string> {
  const tree = await parse(source, lang);
  try {
    const fns = extractFunctions(tree, source);
    if (fns.length === 0) throw new Error("no function found in snippet");
    return hashFunction(normalize(fns[0]!.bodyAst));
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
