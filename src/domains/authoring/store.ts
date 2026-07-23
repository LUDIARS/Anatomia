/**
 * src/domains/authoring/store.ts — Persist editable domain defs as JSON.
 *
 * Editable defs live in the project's ontology dir (default
 * `<repoRoot>/.anatomia/domains/`), one JSON file per domain. Because that dir
 * IS the `pluginDir` the analyze pipeline already loads (Project.ontologyDir),
 * a saved def is detected with no further wiring — the authoring layer feeds the
 * existing detection layer.
 *
 * Each draft's membership is expressed as a "membership marker" preset: a
 * couplingCap with an effectively-infinite cap whose target NodeFilter is the
 * path/name pattern. Detection collects that filter → the matched functions
 * become the domain's implementors, and the cap never fires (so it adds no false
 * violation). This is the bridge from a coarse pattern to first-class
 * implementors without a new preset/engine change.
 *
 * SRP: filesystem read/write + draft→def shaping only. Synthesis is draft.ts,
 * merging is reconcile.ts.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, extname } from "node:path";
import type { ConfiguredPreset, DomainDef } from "../ontology.js";
import type { DomainDraft, EditableDomainDef } from "./types.js";

/** Default per-repo domains dir (also a valid ontology pluginDir). */
export function domainsDir(repoRoot: string): string {
  return join(repoRoot, ".anatomia", "domains");
}

/**
 * A filename-safe, collision-free name for a domain's JSON file. The ASCII slug
 * is readable but lossy (non-ASCII names — common in JP specs — collapse), so a
 * short hash of the FULL name is appended: distinct names never share a file
 * (avoids silent overwrite/data loss), while the same name is idempotent.
 */
export function domainFileName(name: string): string {
  const trimmed = name.trim();
  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const hash = createHash("sha256").update(trimmed, "utf8").digest("hex").slice(0, 8);
  return `${slug || "domain"}.${hash}.json`;
}

/**
 * Membership-marker preset for a pattern. A couplingCap with a huge cap turns the
 * pattern into a NodeFilter the detector collects (→ implementors) while never
 * producing a violation.
 */
function membershipPreset(pattern: string, by: "path" | "name"): ConfiguredPreset {
  return {
    preset: "couplingCap",
    params: { targetPattern: pattern, by, maxFanOut: Number.MAX_SAFE_INTEGER },
  };
}

/** Convert a coarse draft into a persisted, editable DomainDef. */
export function draftToEditableDef(draft: DomainDraft): EditableDomainDef {
  const presetRules: ConfiguredPreset[] = [
    ...draft.pathPatterns.map((p) => membershipPreset(p, "path")),
    ...draft.namePatterns.map((p) => membershipPreset(p, "name")),
  ];
  return {
    name: draft.name,
    description: draft.description,
    presetRules,
    templateRules: [],
    cardTemplate: `Summarise the "${draft.name}" domain: ${draft.description}`,
    source: "spec-draft",
    mechanics: draft.mechanics,
    specRefs: draft.specRefs,
    rationale: draft.rationale,
  };
}

/** Minimal structural check that a parsed object is an EditableDomainDef. */
function isEditableDef(x: unknown): x is EditableDomainDef {
  if (!x || typeof x !== "object") return false;
  const d = x as Record<string, unknown>;
  return (
    typeof d.name === "string" &&
    typeof d.description === "string" &&
    Array.isArray(d.presetRules) &&
    Array.isArray(d.templateRules)
  );
}

/** Load every editable domain def from a dir (missing dir → []). */
export async function editableDomainDocumentPaths(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => extname(entry).toLowerCase() === ".json")
    .sort()
    .map((entry) => join(dir, entry));
}

interface EditableDomainDocument {
  path: string;
  wasArray: boolean;
  definitions: EditableDomainDef[];
}

async function loadEditableDomainDocuments(dir: string): Promise<EditableDomainDocument[]> {
  const documents: EditableDomainDocument[] = [];
  for (const path of await editableDomainDocumentPaths(dir)) {
    const raw = await readFile(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`invalid JSON in ${path}`);
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const definitions: EditableDomainDef[] = [];
    for (const d of list) {
      if (!isEditableDef(d)) throw new Error(`invalid domain def in ${path}`);
      // Default provenance for hand-written files without a `source`.
      if (!("source" in (d as object))) (d as EditableDomainDef).source = "manual";
      definitions.push(d as EditableDomainDef);
    }
    documents.push({ path, wasArray: Array.isArray(parsed), definitions });
  }
  return documents;
}

/** Load every editable domain def from a dir (missing dir → []). */
export async function loadEditableDomains(dir: string): Promise<EditableDomainDef[]> {
  return (await loadEditableDomainDocuments(dir)).flatMap((document) => document.definitions);
}

/** Persist a single editable def to `<dir>/<slug>.json` (creates dir). */
export async function saveEditableDomain(
  dir: string,
  def: EditableDomainDef,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, domainFileName(def.name));
  const withStamp: EditableDomainDef = { ...def, updatedAt: new Date().toISOString() };
  await writeFile(path, JSON.stringify(withStamp, null, 2) + "\n", "utf8");
  return path;
}

/**
 * Persist a whole set while preserving the source JSON document for existing
 * names (including retune/hand-written filenames and array documents).
 */
export async function saveEditableDomains(
  dir: string,
  defs: EditableDomainDef[],
): Promise<string[]> {
  const byName = new Map<string, EditableDomainDef>();
  for (const def of defs) {
    if (byName.has(def.name)) throw new Error(`duplicate domain definition "${def.name}"`);
    byName.set(def.name, def);
  }

  const documents = await loadEditableDomainDocuments(dir);
  const paths: string[] = [];
  const handled = new Set<string>();
  const stamp = (def: EditableDomainDef): EditableDomainDef => ({
    ...def,
    updatedAt: new Date().toISOString(),
  });
  for (const document of documents) {
    let changed = false;
    const definitions = document.definitions.map((existing) => {
      const replacement = byName.get(existing.name);
      if (!replacement) return existing;
      changed = true;
      handled.add(existing.name);
      return replacement;
    });
    if (!changed) continue;
    const payload = document.wasArray
      ? definitions.map(stamp)
      : stamp(definitions[0]!);
    await writeFile(document.path, JSON.stringify(payload, null, 2) + "\n", "utf8");
    paths.push(document.path);
  }
  for (const def of defs) {
    if (!handled.has(def.name)) paths.push(await saveEditableDomain(dir, def));
  }
  return paths;
}

/** Strip authoring metadata back to a plain DomainDef (for ad-hoc detection). */
export function toDomainDef(def: EditableDomainDef): DomainDef {
  return {
    name: def.name,
    description: def.description,
    presetRules: def.presetRules,
    templateRules: def.templateRules,
    cardTemplate: def.cardTemplate,
    membership: def.membership,
  };
}
