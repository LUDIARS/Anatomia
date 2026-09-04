/**
 * src/project/file-cache.ts — per-file analysis DISK cache.
 *
 * The cross-RESTART analogue of AnalyzeOptions.priorFiles: analyze() phase 1
 * consults it before parsing, and persists each freshly-parsed, AST-released
 * FileNode after consuming its mirrors (edge info + template matches). Entries
 * are content-addressed by (absolute path + source SHA-256) — the path is part
 * of the key because AnchorId folds the file path into its hash, so the same
 * content at a different path must miss.
 *
 * SRP: gzip-JSON storage of AST-less FileNodes under a directory. No analysis
 * logic, no registry knowledge (manager.ts wires the per-project directory).
 * Every failure degrades to a miss / no-op: this is a cache, not correctness.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { FileNode } from "../types.js";
import type { FileAnalysisCache } from "../core.js";

/**
 * Bump when the serialized FileNode shape changes incompatibly (fields the
 * graph/detection path depends on). Folded into the entry key, so a bump
 * simply orphans old entries rather than mis-reading them.
 */
// 2: invalidate edgeInfo extracted before TypeScript member calls were recorded.
const FORMAT_VERSION = 2;
const MAX_COMPRESSED_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_DECOMPRESSED_ENTRY_BYTES = 256 * 1024 * 1024;

interface StoredEntry {
  version: number;
  file: FileNode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

/** Validate the cache's executable analysis inputs before exposing parsed JSON. */
function isStoredFile(value: unknown, filePath: string, contentHash: string): value is FileNode {
  if (!isRecord(value)) return false;
  if (value["path"] !== filePath || value["contentHash"] !== contentHash) return false;
  if (value["hash"] !== null && typeof value["hash"] !== "string") return false;
  if (!Array.isArray(value["functions"])) return false;
  if (value["templateKeys"] !== undefined && !isStringArray(value["templateKeys"])) return false;
  if (value["types"] !== undefined && !Array.isArray(value["types"])) return false;
  const templateKeys = value["templateKeys"] as string[] | undefined;
  return value["functions"].every((candidate) => {
    if (!isRecord(candidate) || "bodyAst" in candidate) return false;
    const id = candidate["id"];
    const range = candidate["sourceRange"];
    const edgeInfo = candidate["edgeInfo"];
    if (typeof id !== "string" || typeof candidate["name"] !== "string") return false;
    if (typeof candidate["signature"] !== "string" || !isRecord(range)) return false;
    if (range["filePath"] !== filePath || !isRecord(edgeInfo)) return false;
    if (edgeInfo["anchorId"] !== id) return false;
    if (
      !Array.isArray(edgeInfo["calls"])
      || !edgeInfo["calls"].every((call) =>
        isRecord(call)
        && typeof call["name"] === "string"
        && (call["receiver"] === null || isStringArray(call["receiver"])))
      || !isStringArray(edgeInfo["readFieldNames"])
    ) return false;
    if (!isStringArray(edgeInfo["writeFieldNames"])) return false;
    if (!isStringRecord(edgeInfo["symbolTypes"]) || !isStringRecord(edgeInfo["containerElem"])) return false;
    if (!Array.isArray(edgeInfo["callLocals"]) || !Array.isArray(edgeInfo["rangeFors"])) return false;
    const matches = candidate["templateMatches"];
    const matchesAreValid = matches === undefined || (
      isRecord(matches)
      && Object.values(matches).every((entry) => entry === null || typeof entry === "string")
    );
    return matchesAreValid && (
      templateKeys === undefined
      || (matches !== undefined && templateKeys.every((key) =>
        Object.prototype.hasOwnProperty.call(matches, key)))
    );
  });
}

export class FileAnalysisDiskCache implements FileAnalysisCache {
  /** Root directory for entries (created lazily on first write). */
  constructor(private readonly dir: string) {}

  private keyFor(filePath: string, contentHash: string): string {
    const normalizedPath = filePath.replace(/\\/g, "/");
    return createHash("sha256")
      .update(`${FORMAT_VERSION}\0${normalizedPath}\0${contentHash}`)
      .digest("hex");
  }

  /** Two-level fan-out so a large repo does not put ~50k files in one dir. */
  private pathFor(key: string): string {
    return join(this.dir, key.slice(0, 2), `${key}.json.gz`);
  }

  async get(filePath: string, contentHash: string): Promise<FileNode | null> {
    try {
      const buf = await readFile(this.pathFor(this.keyFor(filePath, contentHash)));
      if (buf.byteLength > MAX_COMPRESSED_ENTRY_BYTES) return null;
      const json = gunzipSync(buf, { maxOutputLength: MAX_DECOMPRESSED_ENTRY_BYTES })
        .toString("utf8");
      const entry = JSON.parse(json) as Partial<StoredEntry>;
      if (entry?.version !== FORMAT_VERSION) return null;
      // The key already folds path+content; verify anyway so a hash collision
      // or a foreign file dropped into the dir cannot poison an analysis.
      return isStoredFile(entry.file, filePath, contentHash) ? entry.file : null;
    } catch {
      return null; // absent / corrupt / unreadable → miss
    }
  }

  async set(filePath: string, contentHash: string, file: FileNode): Promise<void> {
    let tmp: string | null = null;
    try {
      const path = this.pathFor(this.keyFor(filePath, contentHash));
      await mkdir(dirname(path), { recursive: true });
      // bodyAst is stripped defensively: analyze() only writes AST-released
      // nodes, but a retained mirror would both bloat the entry and cycle
      // JSON.stringify (mirror nodes hold parent links).
      const json = JSON.stringify(
        { version: FORMAT_VERSION, file } satisfies StoredEntry,
        (key, value: unknown) => (key === "bodyAst" ? undefined : value),
      );
      // Write-then-rename so a crash mid-write leaves no truncated entry a
      // later get() could try to parse (it would still miss, but why risk it).
      tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
      await writeFile(tmp, gzipSync(json));
      await rename(tmp, path);
    } catch {
      // Cache write failure must never fail the analysis.
    } finally {
      if (tmp) {
        try {
          await rm(tmp, { force: true });
        } catch {
          // The cache result is already decided; temporary cleanup is best effort.
        }
      }
    }
  }
}
