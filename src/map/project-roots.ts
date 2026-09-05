/**
 * src/map/project-roots.ts — Which registered projects the index actually covers.
 *
 * The registry the bundle walks is SHARED and long-lived: every session that
 * analyses a throw-away worktree registers it, and nothing unregisters it when
 * that worktree is deleted. Left alone, the map indexes the wreckage — a search
 * for 「切り絵のデモ」 answered with the same Pictor content twice, once under
 * `pictor` and once under `pictor-5bfd9645e639`, and half the result slots spent
 * on checkouts that no longer exist.
 *
 * Two rules, both taken from the filesystem rather than from the registry's own
 * claims:
 *
 *   1. LIVENESS — a root that is gone, or that holds nothing but Anatomia's own
 *      `.anatomia` cache dir, has no declarations left to index.
 *   2. IDENTITY — two registrations of the SAME repository are one project.
 *      Linked worktrees share the main checkout's git dir (`--git-common-dir`),
 *      so the main root plus the path inside the checkout is the identity two
 *      registrations of one repo agree on and two sibling directories do not.
 *
 * Nothing is dropped silently: every exclusion and every fold is counted, with
 * its reason, into the bundle's `notes[]` and into the process log.
 *
 * SRP: deciding which sources survive. Building a map is sources.ts, bundling
 * them is bundle.ts.
 */
// @implements SPEC-domain-map

import { readdir, stat } from "node:fs/promises";
import { platform } from "node:os";
import { relative, resolve } from "node:path";
import { resolveRepoRoots, type RepoRoots } from "../branch/git.js";
import { vgWrite } from "../obs/vestigium.js";

/** Anatomia's own per-repo cache dir — outlives the checkout it was written in. */
const CACHE_DIR = ".anatomia";

/** How long a root probe is reused before the filesystem is asked again. */
const DEFAULT_PROBE_CACHE_MS = 30_000;

/** The minimum a bundle source has to look like to be normalised. */
export interface MapSourceLike {
  id: string;
  rootPath: string;
}

/** Why a root is not worth indexing. */
export type DeadRootReason = "missing" | "emptied";

/** What the filesystem and git say about one registered root. */
export interface ProjectRootProbe {
  /** Set when the root cannot be indexed, null when it can. */
  dead: DeadRootReason | null;
  /** Identity of the checkout: main repo root + the path inside it. */
  key: string;
  /** True when the root is the repository's main checkout, not a linked worktree. */
  isMainCheckout: boolean;
}

/** Options for {@link normalizeMapSources}. */
export interface NormalizeSourcesOptions {
  /** Root probe, injected by tests so they need neither git nor a real repo. */
  probe?: (rootPath: string) => Promise<ProjectRootProbe>;
  /** Monotonic-enough wall clock, for probe-cache expiry tests. */
  nowMs?: () => number;
  /** Lifetime of the probe memo; 0 re-probes on every call. */
  probeCacheMs?: number;
}

/** Surviving sources plus the diagnostics that say what was removed and why. */
export interface NormalizedSources<T> {
  sources: T[];
  notes: string[];
}

/**
 * Drop dead roots, fold duplicate registrations of one repository into one.
 *
 * Order is preserved: the survivor keeps the position of its own registration in
 * the caller's list, so the bundle's project order stays stable as duplicates
 * come and go.
 */
export async function normalizeMapSources<T extends MapSourceLike>(
  sources: T[],
  options: NormalizeSourcesOptions = {},
): Promise<NormalizedSources<T>> {
  const probe = options.probe ?? ((rootPath: string) => memoizedProbe(rootPath, options));
  const notes: string[] = [];
  const dead: Record<DeadRootReason, string[]> = { missing: [], emptied: [] };

  const live: { source: T; probe: ProjectRootProbe }[] = [];
  for (const source of sources) {
    const state = await probe(source.rootPath);
    if (state.dead !== null) {
      dead[state.dead].push(source.id);
      continue;
    }
    live.push({ source, probe: state });
  }

  const groups = new Map<string, { source: T; probe: ProjectRootProbe }[]>();
  for (const entry of live) {
    const group = groups.get(entry.probe.key);
    if (group) group.push(entry);
    else groups.set(entry.probe.key, [entry]);
  }

  const kept = new Set<T>();
  const folded: string[] = [];
  for (const group of groups.values()) {
    const ranked = [...group].sort((a, b) => byRepresentative(a, b));
    const winner = ranked[0]!;
    kept.add(winner.source);
    for (const loser of ranked.slice(1)) folded.push(`${loser.source.id} → ${winner.source.id}`);
  }

  if (dead.missing.length > 0) {
    notes.push(`索引から除外: root が存在しません (${dead.missing.length} 件: ${dead.missing.join(", ")})。`);
  }
  if (dead.emptied.length > 0) {
    notes.push(
      `索引から除外: root に ${CACHE_DIR} 以外が残っていません`
        + ` (${dead.emptied.length} 件: ${dead.emptied.join(", ")})。`,
    );
  }
  if (folded.length > 0) {
    notes.push(`同一リポジトリの重複登録を集約 (${folded.length} 件: ${folded.join(", ")})。`);
  }
  report(notes, dead, folded.length);
  return { sources: sources.filter((source) => kept.has(source)), notes };
}

/**
 * Which registration represents a repository.
 *
 * The main checkout first — a worktree is only ever the answer when the repo it
 * came from is not registered at all. Then a human-readable id: registering a
 * second root under a taken name mints `<name>-<12 hex>` (project/registry.ts
 * `rootHash`), and that generated id is never what a person means by "pictor".
 * Length then order keep the choice deterministic for two equally plain ids.
 */
function byRepresentative<T extends MapSourceLike>(
  a: { source: T; probe: ProjectRootProbe },
  b: { source: T; probe: ProjectRootProbe },
): number {
  return (
    Number(b.probe.isMainCheckout) - Number(a.probe.isMainCheckout)
    || Number(isGeneratedProjectId(a.source.id)) - Number(isGeneratedProjectId(b.source.id))
    || a.source.id.length - b.source.id.length
    || a.source.id.localeCompare(b.source.id)
  );
}

/**
 * True for the `<name>-<root hash>` id the registry mints on a name collision.
 *
 * The suffix is a 12-character slice of a sha256 (project/registry.ts
 * `rootHash`), so the shape is exact enough to test for: exactly twelve hex
 * characters after the last hyphen. Real ids (`vtn-connect`, `all-in-onetest`,
 * `ars-feat-domain-review-skills`) do not look like it.
 */
export function isGeneratedProjectId(id: string): boolean {
  return /-[0-9a-f]{12}$/.test(id);
}

/** Probe memo, so the warm server does not spawn a git per project per search. */
const probeMemo = new Map<string, { at: number; value: ProjectRootProbe }>();

/** Drop the probe memo (tests, and after a registry change). */
export function clearProjectRootMemo(): void {
  probeMemo.clear();
  reported.clear();
}

async function memoizedProbe(
  rootPath: string,
  options: NormalizeSourcesOptions,
): Promise<ProjectRootProbe> {
  const now = options.nowMs?.() ?? Date.now();
  const ttl = Math.max(0, options.probeCacheMs ?? DEFAULT_PROBE_CACHE_MS);
  const cached = probeMemo.get(rootPath);
  if (cached && now - cached.at < ttl) return cached.value;
  const value = await probeProjectRoot(rootPath);
  probeMemo.set(rootPath, { at: now, value });
  return value;
}

/**
 * Ask the filesystem and git about one registered root.
 *
 * A deleted worktree usually leaves its directory behind holding only the
 * `.anatomia` cache Anatomia itself wrote there, which is why "the path exists"
 * is not the liveness test — "there is something left to index" is.
 */
export async function probeProjectRoot(rootPath: string): Promise<ProjectRootProbe> {
  const path = resolve(rootPath);
  const dead = await deadReason(path);
  if (dead !== null) return { dead, key: identityKey(path, null), isMainCheckout: true };
  const roots = await resolveRepoRoots(path);
  return {
    dead: null,
    key: identityKey(path, roots),
    isMainCheckout: roots === null || sameRoot(roots.worktree, roots.main),
  };
}

async function deadReason(path: string): Promise<DeadRootReason | null> {
  let entries: string[];
  try {
    if (!(await stat(path)).isDirectory()) return "missing";
    entries = await readdir(path);
  } catch {
    return "missing";
  }
  return entries.some((entry) => entry !== CACHE_DIR) ? null : "emptied";
}

/**
 * The identity two registrations of one checkout share.
 *
 * A root may legitimately be a SUBDIRECTORY of a repo (a monorepo package, a
 * workspace's `src`), and those are different analysis scopes rather than
 * duplicates — so the path inside the checkout is part of the key. Outside a git
 * checkout the resolved path is all the identity there is.
 */
function identityKey(path: string, roots: RepoRoots | null): string {
  const canonical = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (roots === null) return comparablePath(canonical);
  const within = relative(roots.worktree, canonical).replace(/\\/g, "/");
  return `${comparablePath(roots.main)}\u0000${comparablePath(within)}`;
}

function sameRoot(a: string, b: string): boolean {
  return comparablePath(a) === comparablePath(b);
}

/** Windows paths are case-insensitive; POSIX paths are not necessarily so. */
function comparablePath(path: string): string {
  return platform() === "win32" ? path.toLowerCase() : path;
}

/** Say what was removed — once per distinct outcome, not once per search. */
const reported = new Set<string>();

function report(notes: string[], dead: Record<DeadRootReason, string[]>, folded: number): void {
  if (notes.length === 0) return;
  const key = notes.join("\n");
  if (reported.has(key)) return;
  reported.add(key);
  for (const note of notes) console.warn(`[anatomia] domain-map: ${note}`);
  // Counts only: a registry root is an absolute local path, often carrying a
  // user name, and the shared transcript is not the place for it.
  vgWrite("warn", "domain-map registry normalised", {
    missing: dead.missing.length,
    emptied: dead.emptied.length,
    folded,
  });
}
