/**
 * src/adapters/web/source-view-candidates.ts — the files and lines a domain is
 * implemented by, as the user's choices for "open in Tela".
 *
 * Candidates come only from the analysis result (the domain's implementor
 * anchors → their functions' file and start line). Every implementor is listed
 * so the user picks one; nothing opens "the first file" on the user's behalf.
 * Each candidate carries the analyzed content hash of its file so the launch
 * can tell the user when the file changed since the analysis.
 *
 * SRP: derive candidates from an AnalysisContext.
 *
 * @spec Tela source viewer launch
 */

import { relative, sep } from "node:path";
import type { AnalysisContext } from "../../core.js";

export interface SourceViewCandidate {
  anchor: string;
  name: string;
  enclosingType: string | null;
  /** Repo-relative, forward-slashed. */
  file: string;
  /** 1-based start line of the function. */
  line: number;
}

export type SourceViewCandidates =
  | { ok: true; domain: string; candidates: SourceViewCandidate[] }
  | { ok: false; reason: "unknown-domain"; message: string };

const byLocation = (a: SourceViewCandidate, b: SourceViewCandidate): number =>
  (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export function sourceViewCandidates(ctx: AnalysisContext, domain: string): SourceViewCandidates {
  const detection = (ctx.domains ?? []).find((entry) => entry.domain === domain);
  if (!detection) return { ok: false, reason: "unknown-domain", message: `ドメイン "${domain}" は解析結果にありません。` };
  const functions = new Map(ctx.functions.filter((fn) => fn.id).map((fn) => [fn.id!, fn]));
  const candidates: SourceViewCandidate[] = [];
  for (const anchor of new Set(detection.implementors)) {
    const fn = functions.get(anchor);
    if (!fn) continue;
    candidates.push({
      anchor,
      name: fn.name,
      enclosingType: fn.enclosingType ?? null,
      file: relative(ctx.repoPath, fn.sourceRange.filePath).split(sep).join("/"),
      line: fn.sourceRange.start.line + 1,
    });
  }
  return { ok: true, domain, candidates: candidates.sort(byLocation) };
}

/** Analyzed content hash of a repo-relative file, when the analysis recorded one. */
export function analyzedContentHash(ctx: AnalysisContext, file: string): string | undefined {
  const match = ctx.files.find((entry) => relative(ctx.repoPath, entry.path).split(sep).join("/") === file);
  return match?.contentHash;
}
