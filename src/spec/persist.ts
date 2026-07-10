/**
 * src/spec/persist.ts — ratified spec-link persistence.
 *
 * Ratified links are human decisions, so they outlive any single analysis:
 * they are stored as a committed artifact at `spec/data/spec-links.json`
 * (same home as the taxonomy), NOT under the local `.anatomia/` state dir.
 * analyze() Phase 5 loads them and merges them over the heuristic linkers'
 * output — ratified links carry evidence=explicit / confidence=1.0, so they
 * win the mergeLinks priority against structural/semantic proposals.
 *
 * A missing file is the INITIAL state (nothing ratified yet) — it loads as an
 * empty list. A present-but-malformed file is a broken artifact and throws
 * (fail-fast; never silently ignore committed data).
 *
 * SRP: load/save of the ratified-link artifact only. Ratification semantics
 * live in harden.ts; merge wiring in core.ts.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Link } from "../types.js";

/** Repo-relative path of the committed ratified-links artifact. */
export const SPEC_LINKS_REL = join("spec", "data", "spec-links.json");

/** On-disk shape (versioned so future migrations can detect old files). */
interface SpecLinksFile {
  version: 1;
  links: Link[];
}

/** Absolute path of the artifact for a repo root. */
export function specLinksPath(repoRoot: string): string {
  return join(repoRoot, SPEC_LINKS_REL);
}

/**
 * Load the ratified links for a repo. Missing file → empty array (initial
 * state). Malformed content → throws.
 */
export async function loadRatifiedLinks(repoRoot: string): Promise<Link[]> {
  const path = specLinksPath(repoRoot);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const parsed = JSON.parse(raw) as SpecLinksFile;
  if (parsed.version !== 1 || !Array.isArray(parsed.links)) {
    throw new Error(`spec-links: unsupported or malformed file at ${path}`);
  }
  return parsed.links;
}

/**
 * Save the ratified subset of `links` (non-ratified entries are dropped — this
 * artifact records decisions, not proposals). Entries are sorted by (from, to)
 * so the committed JSON diffs cleanly. Returns the written path.
 */
export async function saveRatifiedLinks(
  repoRoot: string,
  links: Link[],
): Promise<string> {
  const path = specLinksPath(repoRoot);
  const ratified = links
    .filter((l) => l.ratified === true)
    .sort((a, b) =>
      a.from === b.from
        ? a.to.localeCompare(b.to)
        : String(a.from).localeCompare(String(b.from)),
    );
  const file: SpecLinksFile = { version: 1, links: ratified };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(file, null, 2) + "\n", "utf8");
  return path;
}
