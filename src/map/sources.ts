/**
 * src/map/sources.ts — Build one project's map records (design §12.2).
 *
 * Five deterministic sources, in the order the design lists them:
 *
 *   1. `spec/domains/*.domain.json`   → `core-domain` records (name + description)
 *   2. `spec/domains/content-sources.json` (or the spec/feature H1 fallback)
 *                                     → `content` records, bound to their core domain
 *   3. `.anatomia/layers.json`        → `program-domain` records + each record's layers
 *   4. project mentions + HTTP routes → `links[]` (links.ts)
 *   5. spelling normalisation         → `aliases[]` (aliases.ts)
 *
 * NOTHING here analyses code. The map must be buildable for every registered
 * project on demand, which rules out parsing repos: an `analyze()` per project
 * would turn a millisecond search into minutes. Everything above is a committed
 * declaration or a Markdown heading, so the map is exact where the repo is
 * explicit and silent (with a note) where it is not.
 *
 * SRP: repo → ProjectDomainMap. Indexing is inverted-index.ts, ranking search.ts.
 */
// @implements SPEC-domain-map

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadEditableDomains } from "../domains/authoring/store.js";
import { resolveCommittedOntologyDir } from "../domains/ontology.js";
import { loadProgramDomainConfigWithPresence } from "../domains/program/config.js";
import type { ProgramDomainConfig } from "../domains/program/types.js";
import { aliasKeys } from "./aliases.js";
import {
  CONTENT_SOURCES_REL,
  SPEC_FEATURE_REL,
  collectContentEntries,
  collectContentSourceFiles,
  headingOf,
  loadContentSources,
  type ContentEntry,
} from "./content-sources.js";
import { extractLinks } from "./links.js";
import { projectCodesKey, type ProjectCode } from "./project-codes.js";
import { DOMAIN_MAP_VERSION, type DomainMapRecord, type ProjectDomainMap } from "./types.js";

/** The repo the map is built from. */
export interface MapProjectInput {
  /** Project id (registry id). */
  id: string;
  rootPath: string;
  /** Explicit ontology dir; omitted → the repo's committed `spec/domains`. */
  ontologyDir?: string | undefined;
}

/** Options for {@link buildProjectDomainMap}. */
export interface BuildProjectMapOptions {
  /** LUDIARS roster for name-based links. Empty → route links only. */
  roster?: ProjectCode[];
  /** Why the roster is empty, recorded as a note. */
  rosterError?: string | null;
  /** Clock, injected so tests get a fixed `builtAt`. */
  now?: () => Date;
  /** Already-computed source key, so a cache miss does not scan twice. */
  sourceKey?: string;
}

/** A core domain's concrete ownership claims and preferred specification. */
interface CorePathOwner {
  domain: string;
  paths: string[];
  specs: string[];
  spec: string | null;
}

/** Build the whole map of one project. */
export async function buildProjectDomainMap(
  project: MapProjectInput,
  options: BuildProjectMapOptions = {},
): Promise<ProjectDomainMap> {
  const notes: string[] = [];
  const roster = options.roster ?? [];
  if (roster.length === 0 && options.rosterError) {
    notes.push(`プロジェクト名の索引を取得できないため名前ベースのリンクを省きました (${options.rosterError})。`);
  }

  const ontologyDir = project.ontologyDir ?? committedOntologyDir(project.rootPath);
  const defs = ontologyDir
    ? await loadEditableDomains(ontologyDir, { skipInvalid: true })
    : [];
  if (!ontologyDir) notes.push("spec/domains が無いためコアドメインを索引していません。");

  const { config: layers, present: layersPresent } =
    await loadProgramDomainConfigSafely(project.rootPath, notes);
  if (!layersPresent) notes.push(".anatomia/layers.json が無いためプログラムドメインは空です。");

  const records: DomainMapRecord[] = [];
  const coreByPath: CorePathOwner[] = [];

  for (const def of defs) {
    if ((def.role ?? "semantic") !== "semantic") continue;
    const patterns = (def.membership ?? [])
      .map((filter) => filter.pathPattern)
      .filter((pattern): pattern is string => typeof pattern === "string");
    const hints = patterns.flatMap(pathHintsFromPattern);
    const paths = dedupe(hints.filter((hint) => !hint.endsWith(".md")));
    // A membership may name several spec documents (`kirie(?:-anim|-transform)`).
    // All of them own their content; the record displays the one named after the
    // domain when there is one, so the obvious document is not hidden behind a sibling.
    const specs = dedupe(hints.filter((hint) => hint.endsWith(".md")));
    const spec = specs.find((path) => specStem(path) === def.name) ?? specs[0] ?? null;
    coreByPath.push({ domain: def.name, paths, specs, spec });
    records.push({
      project: project.id,
      kind: "core-domain",
      name: def.name,
      aliases: aliasKeys(def.name),
      coreDomain: def.name,
      programDomains: layersForPaths(layers, paths),
      paths,
      spec,
      links: extractLinks(`${def.name} ${def.description}`, roster, project.id),
      description: def.description,
    });
  }

  const contents = await collectContents(project.rootPath, notes);
  for (const entry of contents) {
    const owner = ownerOf(coreByPath, entry);
    const paths = dedupe([...(entry.path.endsWith(".md") ? [] : [entry.path]), ...(owner?.paths ?? [])]);
    const spec = entry.spec ?? owner?.spec ?? null;
    const text = spec ? await readSpecText(project.rootPath, spec) : "";
    records.push({
      project: project.id,
      kind: "content",
      name: entry.name,
      aliases: aliasKeys(entry.name, owner?.domain),
      coreDomain: owner?.domain ?? null,
      programDomains: layersForPaths(layers, paths),
      paths,
      spec,
      links: extractLinks(`${entry.name} ${text}`, roster, project.id),
      description: firstParagraph(text),
    });
  }

  dedupeContent(records);

  for (const [layer, dirs] of layerDirs(layers)) {
    records.push({
      project: project.id,
      kind: "program-domain",
      name: layer,
      aliases: aliasKeys(layer),
      coreDomain: null,
      programDomains: [layer],
      paths: dirs,
      spec: null,
      links: [],
      description: "",
    });
  }

  return {
    version: DOMAIN_MAP_VERSION,
    project: project.id,
    builtAt: (options.now?.() ?? new Date()).toISOString(),
    sourceKey: options.sourceKey ?? await computeMapSourceKey(project.rootPath, ontologyDir),
    rosterKey: projectCodesKey({ codes: roster, error: options.rosterError ?? null }),
    records: records.sort(byKindThenName),
    notes,
  };
}

/**
 * Drop content records that describe the SAME content twice (mutates `records`).
 *
 * A repo that declares both a catalog manifest and a spec H1 for one game
 * produces two records with the same core domain and the same paths — 「トラン
 * ポリン カウンター」 and 「uni-jump — トランポリン カウンター」. They are one
 * thing, and showing both would spend two of the search's few result slots on it.
 * The shorter name wins: it is the catalog name a person actually types.
 *
 * The DOCUMENT is part of the identity, which is what keeps this from eating a
 * repo alive: two records that describe different spec documents are two things
 * however much their owner and paths coincide. Without it, every document under
 * one domain's membership collapsed into a single record.
 */
function dedupeContent(records: DomainMapRecord[]): void {
  const byKey = new Map<string, DomainMapRecord>();
  const discarded = new Set<DomainMapRecord>();
  for (let at = records.length - 1; at >= 0; at--) {
    const record = records[at]!;
    if (record.kind !== "content" || record.coreDomain === null) continue;
    const key = JSON.stringify([record.coreDomain, record.paths, record.spec]);
    const kept = byKey.get(key);
    if (kept === undefined) {
      byKey.set(key, record);
      continue;
    }
    const loser = kept.name.length < record.name.length ? record : kept;
    // The survivor keeps both spellings so either one still matches exactly.
    const winner = loser === record ? kept : record;
    winner.aliases = [...new Set([...winner.aliases, ...loser.aliases])].sort();
    winner.spec = winner.spec ?? loser.spec;
    discarded.add(loser);
    byKey.set(key, winner);
  }
  const unique = records.filter((record) => !discarded.has(record));
  records.splice(0, records.length, ...unique);
}

/**
 * The content entries of a repo: its declaration when it has one, otherwise the
 * H1 of every `spec/feature/*.md`.
 *
 * The fallback is what makes the map work on day one across LUDIARS — a repo
 * only writes `content-sources.json` when its content is not one-doc-per-feature.
 */
async function collectContents(repoPath: string, notes: string[]): Promise<ContentEntry[]> {
  const { rules, error } = await loadContentSources(repoPath);
  if (error) notes.push(error);
  if (rules && rules.length > 0) return collectContentEntries(repoPath, rules);
  notes.push(`${CONTENT_SOURCES_REL} が無いため ${SPEC_FEATURE_REL}/*.md の H1 で代替しました。`);
  return specFeatureHeadings(repoPath);
}

/** `spec/feature/*.md` → one entry per document that has an H1. */
async function specFeatureHeadings(repoPath: string): Promise<ContentEntry[]> {
  const dir = join(repoPath, SPEC_FEATURE_REL);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith(".md"));
  } catch {
    return [];
  }
  const out: ContentEntry[] = [];
  for (const name of names.sort()) {
    const rel = `${SPEC_FEATURE_REL}/${name}`;
    const heading = headingOf(await readSpecText(repoPath, rel));
    if (!heading) continue;
    out.push({ name: heading, path: rel, spec: rel });
  }
  return out;
}

/**
 * The core domain a content entry belongs to.
 *
 * Bound by PATH, not by name similarity: a domain whose membership claims the
 * entry's spec document or its directory owns that content by declaration, and
 * a guess would be exactly the kind of soft link the map exists to replace.
 */
function ownerOf(
  cores: CorePathOwner[],
  entry: ContentEntry,
): CorePathOwner | undefined {
  // A `dirname` entry lives in its directory but is NAMED by its spec document:
  // the document decides the owner, the directory places it.
  const specTarget = entry.spec ?? entry.path;
  const target = entry.path;
  const exactSpec = cores
    .filter((core) => core.specs.includes(specTarget))
    .sort((a, b) => a.domain.localeCompare(b.domain))[0];
  if (exactSpec) return exactSpec;

  return cores
    .map((core) => ({
      core,
      specificity: Math.max(
        -1,
        ...core.paths
          .filter((path) => path === target || target.startsWith(`${path}/`))
          .map((path) => path.length),
      ),
    }))
    .filter((candidate) => candidate.specificity >= 0)
    .sort((a, b) => b.specificity - a.specificity || a.core.domain.localeCompare(b.core.domain))[0]
    ?.core;
}

/**
 * Every concrete path a `membership[].pathPattern` RegExp source can be reduced to.
 *
 * Membership is declared as a regular expression; the map shows people WHERE to
 * look, so a pattern is turned back into paths two ways:
 *
 *   1. LITERALISE. A pattern built from literals and simple alternations is
 *      expanded into the exact paths it matches:
 *      `spec/feature/kirie(?:-anim|-transform)\.md` → both documents.
 *   2. TRUNCATE, but only for a genuine subtree claim. `src/kirie/(?:.*\/)?[^/]+`
 *      claims everything under `src/kirie`, so the prefix stands in for it.
 *
 * Anything else yields NOTHING. Keeping the literal prefix of a pattern that
 * merely NAMES files inside a directory is what collapsed a repo's whole
 * `spec/feature` into one content record: every document there looked like it
 * belonged to the one domain whose membership happened to name two of them.
 * A membership the map cannot literalise claims no path at all — silence is
 * correct where a guess is a wrong ownership claim.
 */
export function pathHintsFromPattern(pattern: string): string[] {
  const body = pattern
    .replace(/^\(\^\|\/\)/, "")
    .replace(/^\^/, "")
    .replace(/\$$/, "");
  const literal = expandLiteralPaths(body);
  if (literal) {
    return dedupe(literal.map((path) => path.replace(/\/+$/, "")).filter(isSafePathHint));
  }

  const unescaped = body.replace(/\\([.\-/])/g, "$1");
  const kept: string[] = [];
  let rest = unescaped;
  while (rest !== "") {
    const slash = rest.indexOf("/");
    const segment = slash === -1 ? rest : rest.slice(0, slash);
    if (segment !== "" && /[\\^$*+?()[\]{}|]/.test(segment)) break;
    if (segment !== "") kept.push(segment);
    rest = slash === -1 ? "" : rest.slice(slash + 1);
  }
  if (kept.length === 0 || !SUBTREE_TAIL.test(rest)) return [];
  const prefix = kept.join("/");
  return isSafePathHint(prefix) ? [prefix] : [];
}

/** The first path a membership pattern reduces to, or null when it reduces to none. */
export function pathHintFromPattern(pattern: string): string | null {
  return pathHintsFromPattern(pattern)[0] ?? null;
}

/**
 * Tails that claim the whole subtree below the literal prefix.
 *
 * `(?:.*\/)?[^/]+` and `[^/]+` match any name at (or below) the prefix, so the
 * prefix is the honest answer to "where does this domain live". A tail that
 * constrains the NAME (`uni-jump-[a-z-]+\.test\.mjs`) does not: the domain owns
 * two files in `test/`, not `test/`.
 */
const SUBTREE_TAIL = /^(?:\(\?:\.\*\/\)\?|\.\*\/)?(?:\[\^\/\][*+]|\.[*+])?$/;

/** Cap on alternation expansion; a wider pattern is treated as unliteralisable. */
const MAX_LITERAL_PATHS = 32;

/**
 * The exact paths a pattern of literals and simple alternations matches.
 *
 * Returns null as soon as the pattern needs anything else (`.`, `*`, `[…]`, a
 * quantified group): those cannot be enumerated, and the caller falls back to
 * the subtree rule.
 */
function expandLiteralPaths(body: string): string[] | null {
  let out = [""];
  let at = 0;
  while (at < body.length) {
    const char = body[at]!;
    if (char === "\\") {
      const next = body[at + 1];
      if (next === undefined || /[A-Za-z0-9]/.test(next)) return null;
      out = out.map((path) => path + next);
      at += 2;
      continue;
    }
    if (char === "(") {
      const group = readGroup(body, at);
      if (!group) return null;
      if (out.length * group.alternatives.length > MAX_LITERAL_PATHS) return null;
      out = out.flatMap((path) => group.alternatives.map((alternative) => path + alternative));
      at = group.end;
      continue;
    }
    if (/[.*+?[\]{}|^$]/.test(char)) return null;
    out = out.map((path) => path + char);
    at++;
  }
  return out;
}

/** A `(a|b)` / `(?:a|b)` group of literal alternatives, `?` making one of them empty. */
function readGroup(body: string, start: number): { alternatives: string[]; end: number } | null {
  const open = body.startsWith("(?:", start) ? start + 3 : start + 1;
  const close = body.indexOf(")", open);
  if (close === -1) return null;
  const alternatives = readLiteralAlternatives(body.slice(open, close));
  if (!alternatives) return null;
  const optional = body[close + 1] === "?";
  if (!optional && /[*+{]/.test(body[close + 1] ?? "")) return null;
  return {
    alternatives: optional ? [...alternatives, ""] : alternatives,
    end: close + (optional ? 2 : 1),
  };
}

/** Split a group's unescaped `|` delimiters while preserving escaped literals. */
function readLiteralAlternatives(inner: string): string[] | null {
  const alternatives: string[] = [];
  let current = "";
  for (let at = 0; at < inner.length; at++) {
    const char = inner[at]!;
    if (char === "\\") {
      const next = inner[++at];
      if (next === undefined || /[A-Za-z0-9]/.test(next)) return null;
      current += next;
      continue;
    }
    if (char === "|") {
      alternatives.push(current);
      current = "";
      continue;
    }
    if (/[.*+?[\]{}()^$]/.test(char)) return null;
    current += char;
  }
  alternatives.push(current);
  return alternatives;
}

/** Only repository-relative, normalized paths may later be joined to `repoPath`. */
function isSafePathHint(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Layers whose declared globs cover any of `paths`. */
export function layersForPaths(config: ProgramDomainConfig, paths: string[]): string[] {
  const out = new Set<string>();
  for (const rule of config.layers) {
    const dir = ruleDir(rule.glob);
    if (dir === "") continue;
    for (const path of paths) {
      if (path === dir || path.startsWith(`${dir}/`) || dir.startsWith(`${path}/`)) {
        out.add(rule.layer);
      }
    }
  }
  return [...out].sort();
}

/** layer → the declared directories that belong to it. */
function layerDirs(config: ProgramDomainConfig): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const rule of config.layers) {
    const dir = ruleDir(rule.glob);
    if (dir === "") continue;
    out.set(rule.layer, [...new Set([...(out.get(rule.layer) ?? []), dir])].sort());
  }
  return new Map([...out].sort((a, b) => a[0].localeCompare(b[0])));
}

/** The directory a layer glob covers (`renderer/mr/*` → `renderer/mr`). */
function ruleDir(glob: string): string {
  return glob.replace(/\/\*+$/, "").replace(/\/+$/, "");
}

/**
 * Content key over the declaration files the map is derived from.
 *
 * Hash the selected files themselves. Metadata-only keys can remain unchanged
 * after same-length edits with preserved timestamps and return stale names or
 * links indefinitely.
 */
export async function computeMapSourceKey(
  repoPath: string,
  ontologyDir: string | null,
): Promise<string> {
  const hash = createHash("sha256");
  const paths = [...new Set([
    join(repoPath, CONTENT_SOURCES_REL),
    join(repoPath, ".anatomia", "layers.json"),
    ...(await listDir(ontologyDir)),
    ...(await listDir(join(repoPath, SPEC_FEATURE_REL))),
    ...(await declaredContentFiles(repoPath)),
  ])].sort();
  for (const path of paths) {
    const sourcePath = relative(repoPath, path).replace(/\\/g, "/");
    try {
      hash.update(`${sourcePath}\0`, "utf8");
      hash.update(await readFile(path));
      hash.update("\0", "utf8");
    } catch {
      hash.update(`${sourcePath}\0absent\0`, "utf8");
    }
  }
  return hash.digest("hex").slice(0, 32);
}

/** Files selected by `content-sources.json`, including newly added matches. */
async function declaredContentFiles(repoPath: string): Promise<string[]> {
  const { rules } = await loadContentSources(repoPath);
  if (!rules || rules.length === 0) return [];
  return (await collectContentSourceFiles(repoPath, rules)).map((path) => join(repoPath, path));
}

async function listDir(dir: string | null): Promise<string[]> {
  if (!dir) return [];
  try {
    return (await readdir(dir)).map((name) => join(dir, name));
  } catch {
    return [];
  }
}

async function loadProgramDomainConfigSafely(
  repoPath: string,
  notes: string[],
): Promise<{ config: ProgramDomainConfig; present: boolean }> {
  try {
    return await loadProgramDomainConfigWithPresence(repoPath);
  } catch (error) {
    notes.push(`.anatomia/layers.json を読めません: ${error instanceof Error ? error.message : String(error)}`);
    return { config: { layers: [], mergeCouplingThreshold: 1 }, present: false };
  }
}

function committedOntologyDir(repoPath: string): string | null {
  try {
    return resolveCommittedOntologyDir(repoPath);
  } catch {
    return null;
  }
}

async function readSpecText(repoPath: string, rel: string): Promise<string> {
  try {
    return await readFile(join(repoPath, rel), "utf8");
  } catch {
    return "";
  }
}

/** The document's first non-heading, non-list paragraph (its own summary). */
function firstParagraph(markdown: string): string {
  for (const line of markdown.split(/\r?\n/)) {
    const text = line.trim();
    if (text === "" || text.startsWith("#") || text.startsWith("|")) continue;
    return text.replace(/^[-*]\s*/, "").slice(0, 400);
  }
  return "";
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((value) => value !== ""))];
}

/** `spec/feature/kirie-transform.md` → `kirie-transform`. */
function specStem(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.md$/i, "");
}

/** Content first: a person names the product before they name its architecture. */
const KIND_ORDER = ["content", "core-domain", "spec", "scene", "service", "program-domain"];

function byKindThenName(a: DomainMapRecord, b: DomainMapRecord): number {
  const kind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  return kind !== 0 ? kind : a.name.localeCompare(b.name);
}
