/**
 * src/fs/repo-path.ts — repo-relative path identity.
 *
 * Anchor IDs and the content-addressed cache keys both fold a file's path. If
 * that path is ABSOLUTE, the same commit checked out at two places (a repo and
 * a Revisor PR-review worktree) yields different anchors and different cache
 * keys. Graph/domain caches then miss across checkouts, and an anchor cited in
 * one checkout cannot be resolved in the other. (Per-file parse reuse remains
 * an in-process, same-project optimization with its own absolute-path index.)
 *
 * Folding the REPO-RELATIVE path instead makes both identities depend only on
 * the repo's own layout, which is what they mean: "this file, in this project".
 *
 * SRP: path normalisation only — no I/O, no key construction.
 */

import { posix, win32 } from "node:path";

/** Forward slashes, no trailing separator, no leading "./". */
export function normalizeSlashes(path: string): string {
  if (path === "/" || path === "\\") return "/";
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function isWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:(?:$|\/)/.test(path) || path.startsWith("//");
}

/** Collapse `.` / `..` segments without confusing Windows paths on POSIX. */
function normalizeSegments(path: string): string {
  const slashed = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (slashed === "") return "";
  const collapsed = isWindowsPath(slashed)
    ? win32.normalize(slashed)
    : posix.normalize(slashed);
  return normalizeSlashes(collapsed === "." ? "" : collapsed);
}

function isAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:(?:$|\/)/.test(path) || path.startsWith("/");
}

/**
 * `path` expressed relative to `repoRoot`, or unchanged when it does not sit
 * under that root (already relative, or a synthetic path like "<diff>").
 *
 * Windows matching is case-insensitive because it reaches the same file through
 * `E:\Document\...` and `e:\document\...`; POSIX matching remains case-sensitive.
 */
export function toRepoRelative(path: string, repoRoot: string): string {
  const normalized = normalizeSegments(path);
  const root = normalizeSegments(repoRoot);
  if (root === "") return normalized;
  const prefix = root === "/" ? root : `${root}/`;
  // Only Windows paths are case-insensitive. Lowercasing POSIX paths would
  // collapse distinct files (`src/A.ts` and `src/a.ts`) into one identity.
  const isCaseInsensitive = isWindowsPath(root);
  const candidate = isCaseInsensitive ? normalized.toLowerCase() : normalized;
  const comparedPrefix = isCaseInsensitive ? prefix.toLowerCase() : prefix;
  return candidate.startsWith(comparedPrefix)
    ? normalized.slice(prefix.length)
    : normalized;
}

/**
 * Inverse of {@link toRepoRelative}: re-root a relative path at `repoRoot`.
 * Absolute input and parent traversal are rejected so a repo-relative identity
 * cannot escape the root if this helper is later used at an I/O boundary.
 */
export function fromRepoRelative(relPath: string, repoRoot: string): string {
  const normalized = normalizeSegments(relPath);
  const root = normalizeSegments(repoRoot);
  if (root === "" || normalized === "") return normalized;
  if (isAbsolutePath(normalized)) {
    throw new Error("expected a repo-relative path");
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("repo-relative path escapes its root");
  }
  return root === "/" ? `/${normalized}` : `${root}/${normalized}`;
}
