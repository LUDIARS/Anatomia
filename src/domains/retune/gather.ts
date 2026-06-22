/**
 * src/domains/retune/gather.ts — Read the project's purpose + spec headings.
 *
 * Step 1 grounds the taxonomy in WHAT the project is for, not its file layout.
 * That signal comes from README.md / DESIGN.md (purpose) and the headings of
 * spec/feature/*.md (the declared features).
 *
 * SRP: filesystem reads → plain text/heading lists. No LLM, no analysis.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Concatenate README + DESIGN as the purpose excerpt (best-effort). */
export async function gatherPurpose(repoPath: string): Promise<string> {
  const parts: string[] = [];
  for (const f of ["README.md", "DESIGN.md"]) {
    try {
      const text = await readFile(join(repoPath, f), "utf8");
      parts.push(`# ${f}\n${text}`);
    } catch {
      /* optional */
    }
  }
  return parts.join("\n\n");
}

/** Markdown headings (`#`/`##`/`###`) across spec/feature/*.md, prefixed by file. */
export async function gatherSpecHeadings(repoPath: string): Promise<string[]> {
  const dir = join(repoPath, "spec", "feature");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.endsWith(".md")) continue;
    let text: string;
    try {
      text = await readFile(join(dir, e), "utf8");
    } catch {
      continue;
    }
    const heads = text
      .split(/\r?\n/)
      .filter((l) => /^#{1,3}\s/.test(l))
      .map((l) => l.replace(/^#{1,3}\s+/, "").trim());
    // First heading (the feature title) is the most informative; keep it + file.
    if (heads.length > 0) out.push(`${e}: ${heads[0]}`);
    for (const h of heads.slice(1, 4)) out.push(`  · ${h}`);
  }
  return out;
}
