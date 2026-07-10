/**
 * src/spec/stability.ts — link-stability tracking → promotion candidates.
 *
 * A heuristic link that keeps re-appearing across genuinely different
 * analyses (distinct source fingerprints) with non-decreasing confidence is
 * "stable": strong evidence that the linker is not just pattern-noise. Such
 * links become PROMOTION CANDIDATES for the hardening loop — proposals only;
 * ratification stays a human/gate decision (never automatic).
 *
 * State lives in `.anatomia/link-stability.json` (LOCAL state like
 * retune-state.json, not a committed artifact — streaks are per-checkout
 * observations, not decisions). Per (from,to):
 *   { streak, lastConfidence, lastFingerprint }
 *
 * Update rules per completed analysis (updateStability, pure):
 *   - same fingerprint as last time → no-op (a re-analysis of an unchanged
 *     tree is not new evidence);
 *   - link survived with confidence >= last → streak + 1;
 *   - confidence dropped → streak resets to 1 (the evidence weakened);
 *   - link disappeared → entry deleted (also covers "was ratified": the
 *     explicit merge winner replaces the heuristic pair).
 * Only non-explicit links are tracked — explicit ones need no promotion.
 *
 * SRP: stability state (pure update + IO) and candidate extraction only.
 * Ratification lives in ratify.ts; merge policy in harden.ts.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Link } from "../types.js";

/** Default number of stable sightings before a link is proposed for promotion. */
const DEFAULT_PROMOTE_STREAK = 3;

export interface LinkStabilityEntry {
  streak: number;
  lastConfidence: number;
  lastFingerprint: string;
}

/** Keyed by `${from}::${to}` (the mergeLinks pair key). */
export type LinkStabilityState = Record<string, LinkStabilityEntry>;

interface LinkStabilityFile {
  version: 1;
  entries: LinkStabilityState;
}

function pairKey(link: Link): string {
  return `${link.from}::${link.to}`;
}

/** Absolute path of the local state file for a repo root. */
export function linkStabilityPath(repoRoot: string): string {
  return join(repoRoot, ".anatomia", "link-stability.json");
}

/**
 * The promotion streak threshold K. Reads ANATOMIA_LINK_PROMOTE_STREAK
 * (default 3); a set-but-invalid value throws (fail-fast on misconfiguration,
 * never a silent fallback).
 */
export function promoteStreakThreshold(): number {
  const raw = process.env["ANATOMIA_LINK_PROMOTE_STREAK"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_PROMOTE_STREAK;
  const k = Number(raw);
  if (!Number.isInteger(k) || k < 1) {
    throw new Error(
      `ANATOMIA_LINK_PROMOTE_STREAK must be a positive integer, got "${raw}"`,
    );
  }
  return k;
}

/**
 * Fold one completed analysis into the stability state (pure).
 * `fingerprint` identifies the analyzed tree; identical fingerprints are
 * treated as the same observation and never bump streaks.
 */
export function updateStability(
  state: LinkStabilityState,
  links: Link[],
  fingerprint: string,
): LinkStabilityState {
  const next: LinkStabilityState = {};
  for (const link of links) {
    if (link.evidence === "explicit") continue; // nothing to promote
    const key = pairKey(link);
    const prior = state[key];
    if (!prior) {
      next[key] = { streak: 1, lastConfidence: link.confidence, lastFingerprint: fingerprint };
      continue;
    }
    if (prior.lastFingerprint === fingerprint) {
      next[key] = prior; // unchanged tree → not new evidence
      continue;
    }
    const streak = link.confidence >= prior.lastConfidence ? prior.streak + 1 : 1;
    next[key] = { streak, lastConfidence: link.confidence, lastFingerprint: fingerprint };
  }
  // Links absent from `links` are dropped implicitly (entry deleted).
  return next;
}

/** Non-explicit links whose streak has reached the threshold (proposals only). */
export function promotionCandidates(
  state: LinkStabilityState,
  links: Link[],
  threshold: number = promoteStreakThreshold(),
): { link: Link; streak: number }[] {
  const out: { link: Link; streak: number }[] = [];
  for (const link of links) {
    if (link.evidence === "explicit") continue;
    const entry = state[pairKey(link)];
    if (entry && entry.streak >= threshold) {
      out.push({ link, streak: entry.streak });
    }
  }
  return out.sort((a, b) => b.streak - a.streak || String(a.link.from).localeCompare(String(b.link.from)));
}

/** Load the local stability state. Missing file → empty state (initial). */
export async function loadStability(repoRoot: string): Promise<LinkStabilityState> {
  let raw: string;
  try {
    raw = await readFile(linkStabilityPath(repoRoot), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const parsed = JSON.parse(raw) as LinkStabilityFile;
  if (parsed.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) {
    throw new Error(`link-stability: unsupported or malformed file at ${linkStabilityPath(repoRoot)}`);
  }
  return parsed.entries;
}

/** Persist the local stability state. */
export async function saveStability(
  repoRoot: string,
  state: LinkStabilityState,
): Promise<string> {
  const path = linkStabilityPath(repoRoot);
  await mkdir(join(repoRoot, ".anatomia"), { recursive: true });
  const file: LinkStabilityFile = { version: 1, entries: state };
  await writeFile(path, JSON.stringify(file, null, 2) + "\n", "utf8");
  return path;
}

/**
 * Convenience: load → fold one analysis → save. Returns the updated state so
 * callers can extract candidates without a re-read.
 */
export async function recordAnalysis(
  repoRoot: string,
  links: Link[],
  fingerprint: string,
): Promise<LinkStabilityState> {
  const prior = await loadStability(repoRoot);
  const next = updateStability(prior, links, fingerprint);
  await saveStability(repoRoot, next);
  return next;
}
