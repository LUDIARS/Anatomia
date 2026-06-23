/**
 * src/domains/retune/load-taxonomy.ts — Load a repo's taxonomy → module resolver.
 *
 * Best-effort: finds the single `*.taxonomy.json` under <repo>/spec/data and
 * returns a node→module resolver for buildVisData. Any problem (no file, parse
 * error, wrong shape) yields `undefined` so the panel falls back to directory
 * grouping — a missing/curated taxonomy is a normal state, not an error.
 *
 * SRP: filesystem read + shape check → resolver. No graph, no HTTP.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Taxonomy } from "./types.js";
import { moduleResolver } from "./grouping.js";

export type ModuleResolver = (relPath: string, name: string) => string | null;

export async function loadTaxonomyResolver(repoPath: string): Promise<ModuleResolver | undefined> {
  const dir = join(repoPath, "spec", "data");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return undefined;
  }
  const file = entries.find((e) => e.endsWith(".taxonomy.json"));
  if (!file) return undefined;
  try {
    const tax = JSON.parse(await readFile(join(dir, file), "utf8")) as Taxonomy;
    if (!tax || !Array.isArray(tax.domains) || tax.domains.length === 0) return undefined;
    return moduleResolver(tax);
  } catch {
    return undefined;
  }
}
