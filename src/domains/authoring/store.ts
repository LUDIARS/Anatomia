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
export async function loadEditableDomains(dir: string): Promise<EditableDomainDef[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const defs: EditableDomainDef[] = [];
  for (const entry of entries.sort()) {
    if (extname(entry).toLowerCase() !== ".json") continue;
    const raw = await readFile(join(dir, entry), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`invalid JSON in ${join(dir, entry)}`);
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const d of list) {
      if (!isEditableDef(d)) throw new Error(`invalid domain def in ${join(dir, entry)}`);
      // Default provenance for hand-written files without a `source`.
      if (!("source" in (d as object))) (d as EditableDomainDef).source = "manual";
      defs.push(d as EditableDomainDef);
    }
  }
  return defs;
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

/** Persist a whole set of editable defs (one file each). */
export async function saveEditableDomains(
  dir: string,
  defs: EditableDomainDef[],
): Promise<string[]> {
  const paths: string[] = [];
  for (const def of defs) paths.push(await saveEditableDomain(dir, def));
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
  };
}
