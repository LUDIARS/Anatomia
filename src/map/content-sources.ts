/**
 * src/map/content-sources.ts — `spec/domains/content-sources.json` (design §12.2-2).
 *
 * A product knows what its own content IS; Anatomia does not. Rather than guess
 * from directory shapes, each repo DECLARES where its content lives and where
 * the display name comes from:
 *
 *   [{ "glob": "renderer/mr/games/*", "nameFrom": "manifest.json:title" },
 *    { "glob": "demo/<star>/", "nameFrom": "dirname" },   // <star> = a literal *
 *    { "glob": "spec/feature/uni-*.md", "nameFrom": "h1" }]
 *
 * A repo with no declaration is not left out: the caller falls back to the H1 of
 * `spec/feature/*.md` (sources.ts), which is what every LUDIARS repo already
 * writes. The declaration exists so a product can be more precise than that
 * fallback, not as a precondition for being indexed.
 *
 * SRP: read the declaration and resolve it to (name, path) entries. Nothing
 * here builds records or scores anything.
 */
// @implements SPEC-domain-map

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { EXCLUDE_DIRS } from "../fs/walk.js";

/**
 * Where a content entry's display name is read from.
 *
 * `dirname` is the last resort for content that carries no name of its own:
 * `Pictor/demo/*` is 19 shipped demos with neither a manifest nor a README, so
 * the directory name IS the only name that exists. It is normalised
 * (`shadow_play` → 「shadow play」) and never translated — inventing Japanese
 * for a directory would put a name in the index that the repo never wrote.
 */
export type ContentNameSource = "manifest.json:title" | "h1" | "frontmatter:title" | "dirname";

/** One declared content source. */
export interface ContentSourceRule {
  /** Repo-relative glob. A trailing `/` means "directories only". */
  glob: string;
  nameFrom: ContentNameSource;
}

/** One resolved content entry. */
export interface ContentEntry {
  name: string;
  /** Repo-relative path of the directory or file the entry came from. */
  path: string;
  /** The Markdown document the name was read from, when it was one. */
  spec: string | null;
}

/** Repo-relative location of the declaration. */
export const CONTENT_SOURCES_REL = "spec/domains/content-sources.json";

/** Repo-relative dir holding the spec documents a content entry can be named by. */
export const SPEC_FEATURE_REL = "spec/feature";

/** Every accepted `nameFrom`, so the validator and the type cannot drift apart. */
const NAME_SOURCES: ContentNameSource[] = [
  "manifest.json:title",
  "h1",
  "frontmatter:title",
  "dirname",
];

/** A top-level `spec/feature` Markdown document. */
const SPEC_FEATURE_DOC = new RegExp(`^${SPEC_FEATURE_REL}/[^/]+\\.md$`, "i");

/** How deep the content walk descends before giving up (declared globs are shallow). */
const MAX_DEPTH = 8;
const MAX_RULES = 64;
const MAX_GLOB_LENGTH = 1_024;

/**
 * The repo's declared content sources, or null when it declares none.
 *
 * A malformed declaration is reported as an error to the caller rather than
 * silently treated as "no declaration": a typo in the file would otherwise
 * quietly drop a whole product out of the index.
 */
export async function loadContentSources(
  repoPath: string,
): Promise<{ rules: ContentSourceRule[] | null; error: string | null }> {
  let raw: string;
  try {
    raw = await readFile(join(repoPath, CONTENT_SOURCES_REL), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rules: null, error: null };
    return { rules: null, error: `${CONTENT_SOURCES_REL} を読めません: ${message(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { rules: null, error: `${CONTENT_SOURCES_REL} が不正です: JSON を解析できません` };
  }
  try {
    const list = Array.isArray(parsed) ? parsed : (parsed as { sources?: unknown }).sources;
    if (!Array.isArray(list)) throw new Error("配列 (または { sources: [...] }) ではありません");
    if (list.length > MAX_RULES) throw new Error(`要素数は ${MAX_RULES} 以下にしてください`);
    const rules: ContentSourceRule[] = [];
    for (const [index, entry] of list.entries()) {
      const rule = entry as Partial<ContentSourceRule>;
      if (!isSafeContentGlob(rule.glob) || !isNameSource(rule.nameFrom)) {
        // Do not echo arbitrary fields from a repository-owned declaration:
        // this diagnostic is returned by the read API and must not leak values.
        throw new Error(`不正な要素 (${index + 1} 件目)`);
      }
      rules.push({ glob: rule.glob, nameFrom: rule.nameFrom });
    }
    return { rules, error: null };
  } catch (error) {
    return { rules: null, error: `${CONTENT_SOURCES_REL} が不正です: ${message(error)}` };
  }
}

/** Resolve every declared rule to its content entries, in declaration order. */
export async function collectContentEntries(
  repoPath: string,
  rules: ContentSourceRule[],
): Promise<ContentEntry[]> {
  const { matches, entries } = await resolveContentSourceMatches(repoPath, rules);
  const docs = specDocIndex(entries);
  const out: ContentEntry[] = [];
  const seen = new Map<string, number>();
  for (const match of matches) {
    const entry = await readEntry(repoPath, match, docs);
    if (!entry) continue;
    // One spec document describes ONE thing. A repo that declares both its demo
    // directories and `spec/feature/*.md` would otherwise index the demo twice —
    // once under its directory and once under the document that names it.
    const key = entry.spec ?? `${entry.name}\0${entry.path}`;
    const existing = seen.get(key);
    if (existing === undefined) {
      seen.set(key, out.length);
      out.push(entry);
      continue;
    }
    // Prefer the entry that connects the document to the content itself. This
    // keeps the result independent of whether the H1 or dirname rule came first.
    const previous = out[existing]!;
    const hasContentPath = entry.spec !== null && entry.path !== entry.spec;
    const previousHasContentPath = previous.spec !== null && previous.path !== previous.spec;
    if (hasContentPath && !previousHasContentPath) {
      out[existing] = entry;
    }
  }
  return out;
}

/**
 * Files whose metadata must invalidate a prepared domain map.
 *
 * The declaration itself is not enough: display names live in matched
 * manifests and Markdown files, and adding or removing a match changes the
 * index even when `content-sources.json` is untouched.
 */
export async function collectContentSourceFiles(
  repoPath: string,
  rules: ContentSourceRule[],
): Promise<string[]> {
  const { matches } = await resolveContentSourceMatches(repoPath, rules);
  // A `dirname` match names a DIRECTORY, which has no bytes to hash. Listing it
  // still makes adding or removing one change the key, and the spec document a
  // `dirname` entry borrows its name from is hashed with the rest of
  // `spec/feature/` by the caller.
  const files = matches.map((match) =>
    match.nameFrom === "manifest.json:title" ? `${match.path}/manifest.json` : match.path,
  );
  return [...new Set(files)].sort();
}

interface ContentSourceMatch {
  path: string;
  isDirectory: boolean;
  nameFrom: ContentNameSource;
}

/** A `spec/feature` document, keyed by the slug of its file stem. */
interface SpecDoc {
  slug: string;
  path: string;
}

interface WalkEntry {
  path: string;
  isDirectory: boolean;
}

/** Resolve declared globs once so entry loading and cache invalidation agree. */
async function resolveContentSourceMatches(
  repoPath: string,
  rules: ContentSourceRule[],
): Promise<{ matches: ContentSourceMatch[]; entries: WalkEntry[] }> {
  const matches: ContentSourceMatch[] = [];
  // A repository may declare several content rules. Enumerate it once and
  // apply every rule to the same snapshot so request cost does not multiply by
  // the number of declarations.
  const entries = await walkEntries(repoPath);
  for (const rule of rules) {
    const wantsDir = rule.glob.endsWith("/") || rule.nameFrom === "manifest.json:title";
    const pattern = globToRegExp(rule.glob.replace(/\/+$/, ""));
    for (const entry of entries) {
      if (entry.isDirectory === wantsDir && pattern.test(entry.path)) {
        matches.push({ path: entry.path, isDirectory: wantsDir, nameFrom: rule.nameFrom });
      }
    }
  }
  return { matches, entries };
}

/** Read one match's display name; null when the source holds no usable name. */
async function readEntry(
  repoPath: string,
  match: ContentSourceMatch,
  docs: SpecDoc[],
): Promise<ContentEntry | null> {
  const relPath = match.path;
  if (match.nameFrom === "manifest.json:title") {
    const manifest = join(repoPath, relPath, "manifest.json");
    try {
      const parsed = JSON.parse(await readFile(manifest, "utf8")) as Record<string, unknown>;
      const title = parsed["title"] ?? parsed["name"];
      if (typeof title !== "string" || title.trim() === "") return null;
      return { name: title.trim(), path: relPath, spec: null };
    } catch {
      return null;
    }
  }

  if (match.nameFrom === "dirname") return dirnameEntry(repoPath, match, docs);

  let text: string;
  try {
    text = await readFile(join(repoPath, relPath), "utf8");
  } catch {
    return null;
  }
  const name = match.nameFrom === "h1" ? headingOf(text) : frontmatterTitleOf(text);
  if (!name) return null;
  return { name, path: relPath, spec: relPath };
}

/**
 * A directory (or file) named by its own path, bound to its spec when one exists.
 *
 * `demo/shadow_play` and `spec/feature/shadow-play-kirie-backdrop.md` are the
 * same demo written down twice. Binding them here gives ONE entry that carries
 * both the code location and the name a person actually wrote, instead of the
 * directory name competing in the index with the document that explains it.
 */
async function dirnameEntry(
  repoPath: string,
  match: ContentSourceMatch,
  docs: SpecDoc[],
): Promise<ContentEntry | null> {
  const base = match.path.split("/").pop() ?? "";
  const stem = match.isDirectory ? base : base.replace(/\.[A-Za-z0-9]+$/, "");
  const spec = specDocFor(docs, slugOf(stem));
  if (spec) {
    const heading = headingOf(await readText(join(repoPath, spec)));
    if (heading) return { name: heading, path: match.path, spec };
  }
  const name = stem.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
  return name === "" ? null : { name, path: match.path, spec: null };
}

/** `spec/feature/*.md` of one walk, keyed by the slug of each file stem. */
function specDocIndex(entries: WalkEntry[]): SpecDoc[] {
  return entries
    .filter((entry) => !entry.isDirectory && SPEC_FEATURE_DOC.test(entry.path))
    .map((entry) => ({
      slug: slugOf((entry.path.split("/").pop() ?? "").replace(/\.md$/i, "")),
      path: entry.path,
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug) || a.path.localeCompare(b.path));
}

/**
 * The spec document that names the same thing as `slug`, when there is one.
 *
 * Exact stem first, then the `<slug>-…` form a repo uses when the document
 * title says more than the directory does
 * (`shadow_play` → `shadow-play-kirie-backdrop.md`). Never a suffix or
 * substring match: that would bind unrelated documents to a short directory name.
 */
function specDocFor(docs: SpecDoc[], slug: string): string | null {
  if (slug === "") return null;
  const exact = docs.filter((doc) => doc.slug === slug);
  if (exact.length === 1) return exact[0]!.path;
  if (exact.length > 1) return null;

  const prefixed = docs.filter((doc) => doc.slug.startsWith(`${slug}-`));
  return prefixed.length === 1 ? prefixed[0]!.path : null;
}

/** `shadow_play` and `Shadow Play` both key on `shadow-play`. */
function slugOf(value: string): string {
  return value.toLowerCase().replace(/[\s._]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/** The document's first `# ` heading, trimmed of Markdown decoration. */
export function headingOf(markdown: string): string | null {
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match) return match[1]!.replace(/[#*`]/g, "").trim() || null;
  }
  return null;
}

/** `title:` of a leading YAML frontmatter block. */
export function frontmatterTitleOf(markdown: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) return null;
  const title = /^title:\s*(.+?)\s*$/m.exec(match[1]!);
  return title ? title[1]!.replace(/^["']|["']$/g, "").trim() || null : null;
}

/**
 * Repo-relative entries from one bounded repository walk.
 *
 * Prunes the directories the analysis walk prunes (`fs/walk.ts` EXCLUDE_DIRS) so
 * a content glob never descends into node_modules — the map must stay fast
 * enough to run on every prompt.
 */
async function walkEntries(repoPath: string): Promise<WalkEntry[]> {
  const out: WalkEntry[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      const rel = relative(repoPath, full).replace(/\\/g, "/");
      const isDir = entry.isDirectory();
      out.push({ path: rel, isDirectory: isDir });
      if (isDir && !EXCLUDE_DIRS.has(entry.name)) await visit(full, depth + 1);
    }
  };
  try {
    if (!(await stat(repoPath)).isDirectory()) return out;
  } catch {
    return out;
  }
  await visit(repoPath, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * `**` spans separators, `*` does not; everything else is literal.
 *
 * Same grammar as `supply/plan/conformance.ts` uses for planned paths — a glob
 * must mean the same thing in a plan and in a content declaration.
 */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        source += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function isNameSource(value: unknown): value is ContentNameSource {
  return NAME_SOURCES.includes(value as ContentNameSource);
}

function isSafeContentGlob(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_GLOB_LENGTH) return false;
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;
  return !normalized.split("/").includes("..");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
