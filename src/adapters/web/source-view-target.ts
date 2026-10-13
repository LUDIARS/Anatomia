/**
 * src/adapters/web/source-view-target.ts — validate a "show this file at this
 * line" request before anything is launched.
 *
 * The browser only names a REPO-RELATIVE file and a line. Everything else is
 * derived here from the registered project: the absolute path is resolved under
 * the project root, then checked again after symlinks are followed, so neither
 * `..` segments nor a link can point the viewer outside the repository. The
 * request never carries a command, a viewer path or an absolute path.
 *
 * The same line rules as Tela's reader apply (CRLF / LF / bare CR are line
 * breaks, at most 8 MiB), so a line the viewer would reject is rejected here
 * with a message the user can act on instead of opening unrelated code.
 *
 * "Stale" means the file changed after the analysis the candidate came from:
 * the request is still valid, but the user decides whether to open the current
 * file or re-analyze first.
 *
 * SRP: path + line validation. Launching lives in source-view-launch.ts.
 *
 * @spec Tela source viewer launch
 */

import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Tela `tela_source` input limit (spec/feature/source-view.md in Tela). */
export const SOURCE_VIEW_MAX_BYTES = 8 * 1024 * 1024;

export type SourceTargetFailure =
  | "invalid-request"
  | "outside-repository"
  | "missing-file"
  | "not-a-file"
  | "too-large"
  | "line-out-of-range";

export interface SourceTarget {
  /** Absolute path handed to the viewer. */
  absolutePath: string;
  /** Repo-relative, forward-slashed path (for display and the response). */
  file: string;
  /** 1-based line, validated against the current file. */
  line: number;
  lineCount: number;
  /** The file differs from the analyzed snapshot the candidate came from. */
  stale: boolean;
}

export type SourceTargetResult =
  | { ok: true; target: SourceTarget }
  | { ok: false; reason: SourceTargetFailure; message: string };

export interface SourceTargetRequest {
  repoPath: string;
  file: unknown;
  line: unknown;
  /** SHA-256 of the file's bytes at analysis time, when known. */
  analyzedContentHash?: string;
}

/** Same breaks as Tela's reader: CRLF, LF and bare CR each end a line. */
export function countLines(text: string): number {
  if (text.length === 0) return 1;
  const breaks = text.match(/\r\n|\n|\r/g)?.length ?? 0;
  return /(\r\n|\n|\r)$/.test(text) ? breaks : breaks + 1;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

function fail(reason: SourceTargetFailure, message: string): SourceTargetResult {
  return { ok: false, reason, message };
}

export async function resolveSourceTarget(request: SourceTargetRequest): Promise<SourceTargetResult> {
  const { repoPath, file, line } = request;
  if (typeof file !== "string" || file.length === 0 || file.includes("\0") || isAbsolute(file)) {
    return fail("invalid-request", "ファイルはプロジェクト内の相対パスで指定してください。");
  }
  if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) {
    return fail("invalid-request", "行番号は 1 以上の整数で指定してください。");
  }

  const root = resolve(repoPath);
  const requested = resolve(root, file);
  if (!isInside(root, requested)) {
    return fail("outside-repository", "登録されたプロジェクトの外のファイルは開けません。");
  }

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpath(root);
    realTarget = await realpath(requested);
  } catch {
    return fail("missing-file", "ファイルが見つかりません。解析後に移動・削除された可能性があります。再解析してから選び直してください。");
  }
  if (!isInside(realRoot, realTarget)) {
    return fail("outside-repository", "リンク先がプロジェクトの外にあるため開けません。");
  }

  const info = await stat(realTarget);
  if (!info.isFile()) return fail("not-a-file", "ファイルではないため開けません。");
  if (info.size > SOURCE_VIEW_MAX_BYTES) {
    return fail("too-large", "8 MiB を超えるファイルはソースビューアで開けません。");
  }

  const bytes = await readFile(realTarget);
  const lineCount = countLines(bytes.toString("utf8"));
  if (line > lineCount) {
    return fail("line-out-of-range", `${line} 行目はありません (現在 ${lineCount} 行)。ファイルが変更された可能性があります。再解析するか、先頭から開いてください。`);
  }

  const contentHash = createHash("sha256").update(bytes).digest("hex");
  return {
    ok: true,
    target: {
      absolutePath: realTarget,
      file: relative(realRoot, realTarget).split(sep).join("/"),
      line,
      lineCount,
      stale: request.analyzedContentHash !== undefined && request.analyzedContentHash !== contentHash,
    },
  };
}
