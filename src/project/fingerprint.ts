/**
 * src/project/fingerprint.ts — content-addressed pre-analysis fingerprint.
 *
 * A project's `fingerprint` decides whether a cached analysis is still valid
 * WITHOUT re-parsing (see cache.ts). It must change iff the meaningful source /
 * config *content* changes.
 *
 * Earlier this hashed each file's {path, size, mtimeMs}. That made the cache
 * brittle in two ways:
 *   - git operations that rewrite mtimes without touching content (checkout,
 *     pull, rebase, stash, a fresh worktree/clone) flipped the fingerprint and
 *     forced a full, pointless re-analysis of an unchanged tree;
 *   - an edit that preserved a file's byte size *and* landed within the
 *     filesystem's mtime resolution silently kept the old fingerprint and served
 *     a stale context (the `fingerprint-config` test even had to bump size on
 *     purpose to dodge this).
 *
 * So the fingerprint now hashes each file's SHA-256 *content* hash, not its
 * {size, mtimeMs}. To keep that cheap on a long-running server we memoise the
 * content hash per absolute path, keyed (validated) by {size, mtimeMs}: an
 * unchanged file is never re-read, and a file whose stamp changed is re-hashed —
 * if its content turns out identical (the git-op case) the recomputed hash
 * matches and the fingerprint stays put, so the cache is kept.
 */

import { createHash } from "node:crypto";
import { stat, readFile } from "node:fs/promises";
import { collectFilesByExt, readGitignoreDirs, EXCLUDE_DIRS } from "../fs/walk.js";

/**
 * Source extensions whose content defines a project's fingerprint. Limited to
 * files the analysis actually consumes: parsed source languages plus `.md`
 * (specs/docs feed spec-linking). A blanket `.txt` was intentionally left out —
 * it names no source language and has no analysis consumer, so including it only
 * forced large unrelated text assets (logs, data dumps) to be read in full on
 * every fingerprint pass.
 */
const SOURCE_EXTS = new Set([
  ".cpp", ".h", ".cs", ".ts", ".tsx", ".java", ".go", ".md",
]);

/**
 * Extensions stamped from a project's *config* dirs (ontologyDir / specDirs).
 * Folding these into the fingerprint means editing an ontology def or a spec
 * outside the code root busts the cache, so a re-analyze actually re-runs.
 */
const CONFIG_EXTS = new Set([".md", ".mjs", ".js", ".json"]);

/** One file's identity contribution to the fingerprint: its path + content hash. */
interface FileStamp {
  path: string;
  hash: string;
}

/**
 * Process-lifetime content-hash memo, validated by {size, mtimeMs}. The server
 * is long-running, so reusing this across every computeFingerprint call means
 * the steady state stats each file but reads none. A fresh process re-reads each
 * file once — negligible next to the analysis the fingerprint gates.
 */
interface HashMemo {
  size: number;
  mtimeMs: number;
  hash: string;
}
const memo = new Map<string, HashMemo>();

/**
 * Clear the content-hash memo. Mainly for tests that rewrite the *same* path
 * with new content but want to force a re-read regardless of stamp timing.
 */
export function resetFingerprintMemo(): void {
  memo.clear();
}

/** SHA-256 a file's content, reusing the memo when {size, mtimeMs} are unchanged. */
async function contentHash(full: string, size: number, mtimeMs: number): Promise<string> {
  const cached = memo.get(full);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.hash;
  const buf = await readFile(full);
  const hash = createHash("sha256").update(buf).digest("hex");
  memo.set(full, { size, mtimeMs, hash });
  return hash;
}

/**
 * Compute a content-addressed pre-analysis fingerprint of a project's source
 * tree. Walks the root once, content-hashing each source/spec file (memoised),
 * then hashes the sorted (path, contentHash) stamps. No parsing.
 */
export async function computeFingerprint(
  rootPath: string,
  opts: { configDirs?: string[] } = {},
): Promise<string> {
  const stamps = await collectStamps(rootPath, SOURCE_EXTS);
  // Config dirs (ontologyDir / specDirs) outside the code root: stamp their
  // .md/.mjs/.js/.json so config changes invalidate the cached analysis.
  for (const dir of opts.configDirs ?? []) {
    stamps.push(...(await collectStamps(dir, CONFIG_EXTS)));
  }
  // A config dir nested under rootPath would double-count; de-dupe by path.
  const seen = new Set<string>();
  const unique = stamps.filter((s) => (seen.has(s.path) ? false : (seen.add(s.path), true)));
  unique.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return hashStamps(unique);
}

/** Hash a sorted stamp list (path + content hash) into a 32-char fingerprint. */
function hashStamps(stamps: FileStamp[]): string {
  const h = createHash("sha256");
  for (const s of stamps) {
    h.update(s.path.replace(/\\/g, "/"));
    h.update("\0");
    h.update(s.hash);
    h.update("\n");
  }
  return h.digest("hex").slice(0, 32);
}

async function collectStamps(root: string, exts: Set<string>): Promise<FileStamp[]> {
  const out: FileStamp[] = [];
  // Directory-pruning walk (fs/walk.ts): node_modules/dist/.git/.anatomia are
  // never descended into, so the fingerprint scan is O(source tree) not O(repo).
  const gitDirs = await readGitignoreDirs(root);
  const paths = await collectFilesByExt(root, exts, new Set([...EXCLUDE_DIRS, ...gitDirs]));
  for (const full of paths) {
    try {
      const st = await stat(full);
      out.push({ path: full, hash: await contentHash(full, st.size, st.mtimeMs) });
    } catch {
      // file vanished between walk and stat/read — ignore.
    }
  }
  return out;
}
