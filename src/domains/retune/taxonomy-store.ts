/**
 * src/domains/retune/taxonomy-store.ts — Read/write the canonical taxonomy.
 *
 * The taxonomy (spec/data/<project>.taxonomy.json) is the editable source of
 * truth for the curated domain × module model. The adjustment view mutates it
 * (add/remove/rename domains & modules) and SAVES through here — which re-runs
 * `registerTaxonomy`, so the derived artifacts (ontology DomainDefs + the
 * taxonomy spec doc) are regenerated automatically on every edit (the user's
 * 「仕様の調整も自動で行う」).
 *
 * SRP: locate + parse the taxonomy file, and persist via register. No mutations
 * (taxonomy-ops.ts), no LLM.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Taxonomy } from "./types.js";
import { registerTaxonomy } from "./register.js";
import type { RegisterResult } from "./register.js";

/** Load a project's taxonomy (prefers <project>.taxonomy.json, else any). */
export async function loadTaxonomy(
  repoPath: string,
  project: string,
): Promise<Taxonomy | null> {
  const dir = join(repoPath, "spec", "data");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const preferred = `${project}.taxonomy.json`;
  const file = entries.includes(preferred)
    ? preferred
    : entries.find((e) => e.endsWith(".taxonomy.json"));
  if (!file) return null;
  try {
    const tax = JSON.parse(await readFile(join(dir, file), "utf8")) as Taxonomy;
    return tax && Array.isArray(tax.domains) ? tax : null;
  } catch {
    return null;
  }
}

/**
 * Persist a taxonomy by re-registering it. This rewrites the ontology DomainDefs,
 * the taxonomy JSON, and the human-readable spec doc — keeping spec in sync with
 * the edit automatically.
 */
export async function saveTaxonomy(
  repoPath: string,
  taxonomy: Taxonomy,
): Promise<RegisterResult> {
  return registerTaxonomy(repoPath, taxonomy);
}
