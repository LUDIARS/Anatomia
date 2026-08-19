/**
 * src/entrypoints/config.ts — `.anatomia/entrypoints.json` loader.
 *
 * Repository-owned settings that ADD to (never replace) convention detection,
 * per spec/feature/entrypoint-trace-graph.md. A missing file is the normal case
 * — every project must work on conventions alone — but a malformed one is NOT
 * silently ignored: it degrades to the defaults and emits a `config-invalid`
 * diagnostic, so the operator sees that their config did nothing.
 *
 * SRP: parse + normalize + match. Detection lives in detectors/.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EdgeKind } from "../types.js";
import type {
  EntryClass,
  EntryPointConfig,
  EntryPointDiagnostic,
  EntryPointRule,
} from "./types.js";

const ENTRY_CLASSES: readonly EntryClass[] = [
  "process", "http-route", "cli-command", "event-handler",
  "scheduled", "framework-lifecycle", "screen", "explicit",
];

const EDGE_KINDS: readonly EdgeKind[] = ["calls", "depends", "reads", "writes", "implements", "overrides", "includes"];
const CONFIG_RELATIVE_PATH = [".anatomia", "entrypoints.json"] as const;

function configPath(repoPath: string): string {
  return join(repoPath, ...CONFIG_RELATIVE_PATH);
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && code !== "" ? code : "unknown-error";
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key)).sort();
  if (unknown.length > 0) throw new Error(`${where} has unknown field(s): ${unknown.join(", ")}`);
}

/** Conventions-only defaults: what a project with no config file gets. */
export function defaultEntryPointConfig(): EntryPointConfig {
  return { includeTests: false, include: [], exclude: [], traversal: { edgeKinds: ["calls"], maxDepth: 64 } };
}

/** Test sources, excluded from convention detection unless `includeTests`. */
export function isTestPath(relPath: string): boolean {
  return /(?:^|\/)(?:__tests__|tests)\//.test(relPath) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relPath);
}

/** Anchored glob → RegExp (`**` crosses separators, `*` does not). */
function globToRegExp(glob: string): RegExp {
  const expression = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${expression}$`);
}

function ruleFrom(raw: unknown, where: string): EntryPointRule {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where} must be objects`);
  const value = raw as Record<string, unknown>;
  rejectUnknownKeys(value, ["symbol", "pathGlob", "namePattern", "class"], where);
  const rule: EntryPointRule = {};
  for (const key of ["symbol", "pathGlob", "namePattern"] as const) {
    const field = value[key];
    if (field === undefined) continue;
    if (typeof field !== "string" || field === "") throw new Error(`${where}.${key} must be a non-empty string`);
    rule[key] = field;
  }
  if (value["class"] !== undefined) {
    if (!ENTRY_CLASSES.includes(value["class"] as EntryClass)) throw new Error(`${where}.class is not an entry class`);
    rule.class = value["class"] as EntryClass;
  }
  if (rule.namePattern !== undefined) new RegExp(rule.namePattern); // reject an unparsable pattern here, not at match time
  if (!rule.symbol && !rule.pathGlob && !rule.namePattern) throw new Error(`${where} needs symbol, pathGlob or namePattern`);
  return rule;
}

function ruleKey(rule: EntryPointRule): string {
  return [rule.symbol ?? "", rule.pathGlob ?? "", rule.namePattern ?? "", rule.class ?? ""].join("\u0000");
}

function rulesFrom(raw: unknown, where: string): EntryPointRule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${where} must be an array`);
  return raw
    .map((entry, index) => ruleFrom(entry, `${where}[${index}]`))
    .sort((left, right) => ruleKey(left).localeCompare(ruleKey(right)));
}

function traversalFrom(raw: unknown): EntryPointConfig["traversal"] {
  const fallback = defaultEntryPointConfig().traversal;
  if (raw === undefined) return fallback;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("traversal must be an object");
  const value = raw as Record<string, unknown>;
  rejectUnknownKeys(value, ["edgeKinds", "maxDepth"], "traversal");
  let edgeKinds = fallback.edgeKinds;
  if (value["edgeKinds"] !== undefined) {
    const kinds = value["edgeKinds"];
    if (!Array.isArray(kinds) || kinds.length === 0 || !kinds.every((kind) => EDGE_KINDS.includes(kind as EdgeKind))) {
      throw new Error("traversal.edgeKinds must be a non-empty list of edge kinds");
    }
    edgeKinds = [...new Set(kinds as EdgeKind[])].sort();
  }
  let maxDepth = fallback.maxDepth;
  if (value["maxDepth"] !== undefined) {
    const depth = value["maxDepth"];
    if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1) {
      throw new Error("traversal.maxDepth must be a positive integer");
    }
    maxDepth = depth;
  }
  return { edgeKinds, maxDepth };
}

/** Normalize a parsed config object; throws with a reason on anything invalid. */
export function normalizeEntryPointConfig(raw: unknown): EntryPointConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("entrypoints config must be an object");
  const value = raw as Record<string, unknown>;
  rejectUnknownKeys(value, ["includeTests", "include", "exclude", "traversal"], "entrypoints config");
  if (value["includeTests"] !== undefined && typeof value["includeTests"] !== "boolean") {
    throw new Error("includeTests must be a boolean");
  }
  return {
    includeTests: value["includeTests"] === true,
    include: rulesFrom(value["include"], "include"),
    exclude: rulesFrom(value["exclude"], "exclude"),
    traversal: traversalFrom(value["traversal"]),
  };
}

/**
 * Content identity of the repository-owned entry-point config. The main project
 * fingerprint intentionally prunes `.anatomia`, so every cache/artifact that is
 * affected by this file must fold this revision in explicitly.
 */
export async function computeEntryPointConfigRevision(repoPath: string): Promise<string> {
  const hash = createHash("sha256");
  try {
    hash.update(await readFile(configPath(repoPath)));
  } catch (error) {
    hash.update(errorCode(error) === "ENOENT" ? "<missing>" : `<unreadable:${errorCode(error)}>`);
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Load `<repoPath>/.anatomia/entrypoints.json`. Absent → defaults, no
 * diagnostic. Present but unreadable/invalid → defaults + `config-invalid`.
 */
export async function loadEntryPointConfig(
  repoPath: string,
): Promise<{ config: EntryPointConfig; diagnostics: EntryPointDiagnostic[] }> {
  let text: string;
  try {
    text = await readFile(configPath(repoPath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: defaultEntryPointConfig(), diagnostics: [] };
    return {
      config: defaultEntryPointConfig(),
      // Do not persist the host's absolute path through the graph diagnostic.
      diagnostics: [{ kind: "config-invalid", message: `.anatomia/entrypoints.json unreadable (${errorCode(error)})` }],
    };
  }
  try {
    return { config: normalizeEntryPointConfig(JSON.parse(text)), diagnostics: [] };
  } catch (error) {
    return {
      config: defaultEntryPointConfig(),
      diagnostics: [{
        kind: "config-invalid",
        message: `invalid .anatomia/entrypoints.json: ${error instanceof Error ? error.message : String(error)}`,
      }],
    };
  }
}

/** True when every field the rule sets matches this symbol. */
export function ruleMatches(
  rule: EntryPointRule,
  symbol: { anchor: string; name: string; path: string },
): boolean {
  if (rule.symbol !== undefined) {
    const [path, name] = rule.symbol.includes("#") ? rule.symbol.split("#") : [undefined, undefined];
    const bySymbolRef = path !== undefined && path === symbol.path && name === symbol.name;
    if (!bySymbolRef && rule.symbol !== symbol.anchor) return false;
  }
  if (rule.pathGlob !== undefined && !globToRegExp(rule.pathGlob).test(symbol.path)) return false;
  if (rule.namePattern !== undefined && !new RegExp(rule.namePattern).test(symbol.name)) return false;
  return true;
}
