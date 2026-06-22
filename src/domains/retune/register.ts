/**
 * src/domains/retune/register.ts — Step 4: register the taxonomy (mechanical).
 *
 * Writes three committed artifacts under the repo:
 *   - spec/data/ontology/<domain>.domain.json  — membership DomainDefs, loaded by
 *     loadOntology via the project's ontologyDir → drives the Domain View.
 *   - spec/data/<project>.taxonomy.json         — the canonical taxonomy.
 *   - spec/feature/domain-taxonomy.<project>.md — human-readable registration.
 *
 * The ontology dir is kept to ONLY valid DomainDefs (loadOntology throws on any
 * non-def .json there), so the taxonomy JSON lives one level up in spec/data/.
 * Stale def files from a previous pass (renamed/split/merged domains) are
 * removed so the dir always reflects the current taxonomy exactly.
 *
 * SRP: serialization + filesystem writes only. No taxonomy decisions.
 */

import { mkdir, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Taxonomy } from "./types.js";
import { taxonomyToDomainDefs } from "./grouping.js";

/** Ontology dir, relative to repo root (also the value to set as project.ontologyDir). */
export const ONTOLOGY_DIR_REL = "spec/data/ontology";

export interface RegisterResult {
  /** Repo-relative paths written. */
  written: string[];
  /** Absolute ontology dir (set this as the project's ontologyDir). */
  ontologyDir: string;
}

/** Render the taxonomy as a plain-Markdown spec doc (no JSON-in-Markdown). */
export function renderTaxonomyMd(t: Taxonomy): string {
  const lines: string[] = [];
  lines.push(`# ドメイン taxonomy: ${t.project}`);
  lines.push("");
  lines.push(`自己調整パイプライン（[domain-retune](./domain-retune.md)）が生成。反復 ${t.iterations} 回。`);
  lines.push("このファイルは生成物。手で編集せず `npm run retune` で再生成する。");
  lines.push("");
  for (const d of t.domains) {
    lines.push(`## ${d.name}`);
    lines.push("");
    lines.push(d.description || "(説明なし)");
    lines.push("");
    for (const m of d.modules) {
      const paths = m.paths.join(", ");
      const names = m.names && m.names.length ? `; names: ${m.names.join(", ")}` : "";
      lines.push(`- **${m.name}** — ${m.description || ""}  \`paths: ${paths}${names}\``);
    }
    lines.push("");
  }
  if (t.unassigned && t.unassigned.count > 0) {
    lines.push(`## 未割当 (${t.unassigned.count})`);
    lines.push("");
    lines.push("どのモジュールにも属さないノード（次回反復/人間判断の対象）:");
    lines.push("");
    for (const s of t.unassigned.sample) lines.push(`- ${s}`);
    lines.push("");
  }
  return lines.join("\n");
}

export async function registerTaxonomy(repoPath: string, taxonomy: Taxonomy): Promise<RegisterResult> {
  const ontologyDir = join(repoPath, "spec", "data", "ontology");
  await mkdir(ontologyDir, { recursive: true });
  await mkdir(join(repoPath, "spec", "feature"), { recursive: true });

  const defs = taxonomyToDomainDefs(taxonomy);
  const wanted = new Set(defs.map((d) => `${d.name}.domain.json`));

  // Remove stale *.domain.json from a previous pass.
  let existing: string[] = [];
  try {
    existing = await readdir(ontologyDir);
  } catch {
    /* fresh dir */
  }
  for (const e of existing) {
    if (e.endsWith(".domain.json") && !wanted.has(e)) {
      await unlink(join(ontologyDir, e)).catch(() => {});
    }
  }

  const written: string[] = [];
  for (const def of defs) {
    const rel = `${ONTOLOGY_DIR_REL}/${def.name}.domain.json`;
    await writeFile(join(ontologyDir, `${def.name}.domain.json`), JSON.stringify(def, null, 2) + "\n", "utf8");
    written.push(rel);
  }

  const taxRel = `spec/data/${taxonomy.project}.taxonomy.json`;
  await writeFile(join(repoPath, "spec", "data", `${taxonomy.project}.taxonomy.json`), JSON.stringify(taxonomy, null, 2) + "\n", "utf8");
  written.push(taxRel);

  const mdRel = `spec/feature/domain-taxonomy.${taxonomy.project}.md`;
  await writeFile(join(repoPath, "spec", "feature", `domain-taxonomy.${taxonomy.project}.md`), renderTaxonomyMd(taxonomy) + "\n", "utf8");
  written.push(mdRel);

  return { written, ontologyDir };
}
