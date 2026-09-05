/**
 * src/map/content-sources.ts — `spec/domains/content-sources.json` (design §12.2-2).
 *
 * A product knows what its own content IS; Anatomia does not. Rather than guess
 * from directory shapes, each repo DECLARES where its content lives and where
 * the display name comes from:
 *
 *   [{ "glob": "renderer/mr/games/*", "nameFrom": "manifest.json:title" },
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

/** Where a content entry's display name is read from. */
export type ContentNameSource = "manifest.json:title" | "h1" | "frontmatter:title";

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
  const out: ContentEntry[] = [];
  const seen = new Set<string>();
  for (const source of await resolveContentSourceMatches(repoPath, rules)) {
    const entry = await readEntry(repoPath, source.path, source.nameFrom);
    const key = entry ? `${entry.name}\0${entry.path}` : "";
    if (!entry || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
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
  const files = (await resolveContentSourceMatches(repoPath, rules)).map((source) =>
    source.nameFrom === "manifest.json:title"
      ? `${source.path}/manifest.json`
      : source.path,
  );
  return [...new Set(files)].sort();
}

interface ContentSourceMatch {
  path: string;
  nameFrom: ContentNameSource;
}

interface WalkEntry {
  path: string;
  isDirectory: boolean;
}

/** Resolve declared globs once so entry loading and cache invalidation agree. */
async function resolveContentSourceMatches(
  repoPath: string,
  rules: ContentSourceRule[],
): Promise<ContentSourceMatch[]> {
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
        matches.push({ path: entry.path, nameFrom: rule.nameFrom });
      }
    }
  }
  return matches;
}

/** Read one match's display name; null when the source holds no usable name. */
async function readEntry(
  repoPath: string,
  relPath: string,
  nameFrom: ContentNameSource,
): Promise<ContentEntry | null> {
  if (nameFrom === "manifest.json:title") {
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

  let text: string;
  try {
    text = await readFile(join(repoPath, relPath), "utf8");
  } catch {
    return null;
  }
  const name = nameFrom === "h1" ? headingOf(text) : frontmatterTitleOf(text);
  if (!name) return null;
  return { name, path: relPath, spec: relPath };
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
  return value === "manifest.json:title" || value === "h1" || value === "frontmatter:title";
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
