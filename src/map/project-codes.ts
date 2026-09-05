/**
 * src/map/project-codes.ts — LUDIARS project names for cross-project links.
 *
 * A spec that says 「Interpres のジャンプ検知」 or 「Ip 経由」 is naming another
 * project. To turn that into an index edge the map needs the roster of project
 * names and short codes, whose canonical source is Concordia
 * (`GET /v1/project-codes` on the endpoint supplied by Excubitor).
 *
 * Concordia is NOT a dependency: when it is down, the fetch fails, the roster is
 * empty, and the map simply carries no name-based links (route-based links still
 * work). The design says so explicitly ("取得失敗時は空") — the alternative,
 * hard-coding a copy of the table here, would rot silently.
 *
 * SRP: fetch + shape the roster. Matching it against text is links.ts's job.
 */
// @implements SPEC-domain-map

import { createHash } from "node:crypto";

/** One project of the roster. */
export interface ProjectCode {
  /** Registry-style id (lowercased full name). */
  id: string;
  /** Full name, e.g. "Interpres". */
  name: string;
  /** Short code, e.g. "Ip". Empty when the project has none. */
  code: string;
}

/** Roster path appended to the catalog-resolved Concordia base URL. */
export const PROJECT_CODES_PATH = "/v1/project-codes";

/** How long the roster fetch may take before the map gives up on it. */
const FETCH_TIMEOUT_MS = 1500;

/** Options for {@link fetchProjectCodes}, injected by tests. */
export interface ProjectCodesOptions {
  /** Explicit full endpoint, primarily for tests and embedding callers. */
  url?: string;
  timeoutMs?: number;
  /** Injected fetch, so a test never touches the network. */
  fetchImpl?: typeof fetch;
  /** Environment populated from the Excubitor catalog / ProcessMap. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the roster endpoint without embedding a service port in Anatomia.
 * Excubitor is the authority for service locations and supplies CONCORDIA_URL.
 */
export function resolveProjectCodesUrl(options: ProjectCodesOptions = {}): string | null {
  const explicit = options.url?.trim();
  const base = explicit || options.env?.CONCORDIA_URL?.trim()
    || (options.env === undefined ? process.env.CONCORDIA_URL?.trim() : undefined);
  if (!base) return null;
  try {
    const url = explicit ? new URL(explicit) : new URL(PROJECT_CODES_PATH, `${base.replace(/\/+$/, "")}/`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The roster, or `[]` when Concordia is unavailable.
 *
 * Returning empty is a DELIBERATE degradation, not a silent one: the caller
 * records a note on the project map saying name-based links were skipped, so a
 * thin index is explained rather than mistaken for "no links exist".
 */
export async function fetchProjectCodes(
  options: ProjectCodesOptions = {},
): Promise<{ codes: ProjectCode[]; error: string | null }> {
  const url = resolveProjectCodesUrl(options);
  if (!url) {
    return { codes: [], error: "Concordia endpoint is not configured by Excubitor (CONCORDIA_URL)" };
  }
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") return { codes: [], error: "fetch が使えません" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const response = await doFetch(url, { signal: controller.signal });
    if (!response.ok) return { codes: [], error: `project-codes ${response.status}` };
    return { codes: parseProjectCodes(await response.json()), error: null };
  } catch (error) {
    // This reason is exposed by the read-only map API. Keep it actionable
    // without returning a fetch implementation's URL, credentials, or other
    // low-level context to an unauthenticated caller.
    const kind = error instanceof Error && error.name ? error.name : "unknown error";
    return { codes: [], error: `project-codes request failed (${kind})` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Shape whatever Concordia returned into the roster.
 *
 * Accepts both the bare array and the `{ projects: [...] }` envelope, and both
 * `code`/`short` spellings, because the endpoint is another service's contract
 * and a shape change there must not empty the whole index.
 */
export function parseProjectCodes(payload: unknown): ProjectCode[] {
  const list = Array.isArray(payload)
    ? payload
    : ((payload as { projects?: unknown; codes?: unknown } | null)?.projects
      ?? (payload as { codes?: unknown } | null)?.codes);
  if (!Array.isArray(list)) return [];
  const out: ProjectCode[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const name = typeof row["name"] === "string" ? row["name"].trim() : "";
    if (name === "") continue;
    const code = typeof row["code"] === "string"
      ? row["code"].trim()
      : typeof row["short"] === "string" ? row["short"].trim() : "";
    const id = typeof row["id"] === "string" && row["id"].trim() !== ""
      ? row["id"].trim()
      : name.toLowerCase();
    out.push({ id, name, code });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Stable cache key for the link roster, including unavailable vs. empty. */
export function projectCodesKey(
  roster: { codes: ProjectCode[]; error: string | null },
): string {
  const payload = roster.error
    ? "unavailable"
    : JSON.stringify(
      [...roster.codes]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(({ id, name, code }) => [id, name, code]),
    );
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16);
}
