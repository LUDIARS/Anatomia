/**
 * src/domains/authoring/draft.ts — Synthesize coarse domain drafts from the spec.
 *
 * Challenge 1's first step: "ドメインの定義を仕様から抜粋し雑に作る". An injected
 * LLM reads the spec headings + a coarse module map (the directory structure of
 * the code) and proposes domains: a name, a description, candidate member
 * patterns, the spec clauses they tie to, and any mechanics involved. The output
 * is deliberately coarse — a human then adjusts it (reconcile.ts) and the result
 * feeds the existing detection pipeline.
 *
 * The LLM is REQUIRED for synthesis (spec→domain is a semantic mapping). A
 * separate, EXPLICITLY-chosen deterministic seed (`seedDraftsFromStructure`)
 * produces skeleton drafts from spec headings alone when a caller opts out of the
 * LLM — that is a declared alternative, not a silent fallback (RULE_CODE §7.1).
 *
 * SRP: prompt assembly + response parsing + content-keyed caching. Persistence is
 * store.ts; the LLM client is injected.
 */

import { createHash } from "node:crypto";
import type { SpecClause } from "../../types.js";
import type { LLMClient } from "../card.js";
import { versionedKey, type CacheStore } from "../../cache/store.js";
import type { DomainDraft } from "./types.js";

/** BUMP whenever assembleDraftPrompt changes (shared-cache correctness). */
export const DRAFT_PROMPT_VERSION = "2";

const MAX_SPEC_SNIPPETS = 80;
const MAX_SPEC_TEXT_CHARS = 700;

/** Inputs the synthesiser reads. */
export interface DraftInputs {
  /** Parsed spec clauses (the domain seed material). */
  specClauses: SpecClause[];
  /** Absolute source-file paths (→ a coarse module map). */
  filePaths: string[];
}

/** Cache for synthesised drafts (content-keyed). */
export type DraftCache = CacheStore<DomainDraft[]>;

/** Group file paths into a coarse module map (dir → file count), top 40 dirs. */
export function buildModuleMap(filePaths: string[]): { dir: string; files: number }[] {
  const counts = new Map<string, number>();
  for (const p of filePaths) {
    const fwd = p.replace(/\\/g, "/");
    const slash = fwd.lastIndexOf("/");
    const dir = slash >= 0 ? fwd.slice(0, slash) : ".";
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([dir, files]) => ({ dir, files }))
    .sort((a, b) => (b.files !== a.files ? b.files - a.files : a.dir < b.dir ? -1 : 1))
    .slice(0, 40);
}

/** Deterministic content key over the inputs (for the draft cache). */
function draftContentKey(inputs: DraftInputs): string {
  const clauses = inputs.specClauses
    .map((c) => ({
      sourceFile: c.sourceFile,
      heading: c.heading,
      text: c.text.replace(/\s+/g, " ").trim().slice(0, MAX_SPEC_TEXT_CHARS),
    }))
    .sort((a, b) => {
      const ak = `${a.sourceFile}\0${a.heading}\0${a.text}`;
      const bk = `${b.sourceFile}\0${b.heading}\0${b.text}`;
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
  const dirs = buildModuleMap(inputs.filePaths).map((m) => `${m.dir}:${m.files}`);
  return createHash("sha256")
    .update(JSON.stringify({ clauses, dirs }), "utf8")
    .digest("hex");
}

/** Assemble the deterministic synthesis prompt. */
export function assembleDraftPrompt(inputs: DraftInputs): string {
  const lines: string[] = [];
  lines.push(
    "You are seeding Anatomia's domain ontology from a project's spec. Propose a",
    "COARSE set of domains (a human will refine them). A domain is a semantic",
    "grouping of code; it MAY or MAY NOT involve game mechanics; scene/runtime",
    "state is NOT a domain (omit it). Keep it coarse — favour ~5–15 domains.",
    "",
    "SPEC CLAUSES:",
  );
  const clauses = [...inputs.specClauses].sort((a, b) => {
    const ak = `${a.sourceFile}\0${a.heading}\0${a.id}`;
    const bk = `${b.sourceFile}\0${b.heading}\0${b.id}`;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  for (const c of clauses.slice(0, MAX_SPEC_SNIPPETS)) {
    const text = c.text.replace(/\s+/g, " ").trim().slice(0, MAX_SPEC_TEXT_CHARS);
    lines.push(`  - ${c.heading} [${c.id}] (${c.sourceFile})`);
    if (text) lines.push(`    ${text}`);
  }
  lines.push("", "MODULE MAP (directory → #files):");
  for (const m of buildModuleMap(inputs.filePaths)) lines.push(`  - ${m.dir} (${m.files})`);
  lines.push(
    "",
    "Return a JSON array. Each element:",
    "  { name: string,",
    "    description: string,",
    "    pathPatterns: string[]   (regex on source paths, e.g. \"/combat/\"),",
    "    namePatterns: string[]   (regex on function names),",
    "    specRefs: string[]       (spec headings this domain ties to),",
    "    mechanics: string[]      (game mechanics involved; [] if none),",
    "    rationale: string }",
    "Use module-map directories for pathPatterns where a domain maps to a directory.",
  );
  return lines.join("\n");
}

/** Coerce a possibly-stringy / possibly-array field into a string[]. */
function asStringArray(x: unknown): string[] {
  if (Array.isArray(x)) return x.map(String);
  if (typeof x === "string" && x.trim()) return [x];
  return [];
}

/** Parse the LLM response into DomainDraft[] (lenient; tolerates prose). */
export function parseDrafts(text: string): DomainDraft[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const drafts: DomainDraft[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.name !== "string" || !o.name.trim()) continue;
    drafts.push({
      name: o.name.trim(),
      description: typeof o.description === "string" ? o.description : "",
      pathPatterns: asStringArray(o.pathPatterns),
      namePatterns: asStringArray(o.namePatterns),
      specRefs: asStringArray(o.specRefs),
      mechanics: asStringArray(o.mechanics),
      rationale: typeof o.rationale === "string" ? o.rationale : "",
    });
  }
  // Deterministic order by name.
  return drafts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Synthesise domain drafts from the spec via the injected LLM, content-keyed so a
 * re-run on an unchanged spec/module-map skips the call.
 */
export async function synthesizeDomainDrafts(
  inputs: DraftInputs,
  llm: LLMClient,
  cache?: DraftCache,
  modelId = "default",
): Promise<DomainDraft[]> {
  const key = versionedKey(draftContentKey(inputs), modelId, DRAFT_PROMPT_VERSION);
  if (cache) {
    const hit = await cache.get(key);
    if (hit) return hit;
  }
  const prompt = assembleDraftPrompt(inputs);
  const drafts = parseDrafts(await llm(prompt));
  if (cache) await cache.set(key, drafts);
  return drafts;
}

/**
 * Deterministic, EXPLICITLY-chosen skeleton seed: one draft per top-level spec
 * heading segment, with empty membership patterns for the human to fill. A
 * declared alternative to the LLM path (not a silent fallback) for offline use.
 */
export function seedDraftsFromStructure(inputs: DraftInputs): DomainDraft[] {
  const byTop = new Map<string, SpecClause[]>();
  for (const c of inputs.specClauses) {
    const top = c.heading.split("/")[0]!.trim() || c.heading;
    const list = byTop.get(top) ?? [];
    list.push(c);
    byTop.set(top, list);
  }
  const drafts: DomainDraft[] = [];
  for (const [top, clauses] of byTop) {
    drafts.push({
      name: top,
      description: clauses[0]?.text.replace(/\s+/g, " ").trim().slice(0, 160) ?? top,
      pathPatterns: [],
      namePatterns: [],
      specRefs: [...new Set(clauses.map((c) => c.heading))].sort(),
      mechanics: [],
      rationale: "seeded from spec heading (deterministic, no LLM) — fill membership patterns by hand",
    });
  }
  return drafts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
