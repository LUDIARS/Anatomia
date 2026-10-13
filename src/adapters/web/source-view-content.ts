/**
 * src/adapters/web/source-view-content.ts — show a chosen file and line in the
 * browser, with the function it belongs to and that function's call partners.
 *
 * Tela is the dedicated native viewer, but it opens on the server machine. The
 * web view answers the same question ("what does this domain's code look like
 * here?") wherever the panel is open: a bounded window of lines around the
 * requested line, the enclosing function's range highlighted, and the callers /
 * callees from the analyzed graph so the user can walk to the next function.
 *
 * The file is read through the same validation as the Tela launch
 * (source-view-target.ts): repo-relative only, inside the registered project,
 * at most 8 MiB. Text is returned as data; the panel renders it as text, never
 * as HTML. Bytes that are not valid UTF-8 are reported instead of being shown
 * as replacement characters the reader could mistake for source.
 *
 * SRP: build the web view payload from a validated target + the analysis.
 *
 * @spec Web source view
 */

import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import type { AnalysisContext } from "../../core.js";
import type { AnchorId, FunctionNode } from "../../types.js";
import type { SourceTarget } from "./source-view-target.js";

/** Lines shown before / after the requested line in one window. */
export const SOURCE_WINDOW = { before: 40, after: 80 } as const;
/** Call partners listed per direction (the panel says when it is truncated). */
const PARTNER_LIMIT = 30;

export interface SourcePartner {
  anchor: string;
  name: string;
  file: string;
  line: number;
}

export interface SourceViewContent {
  file: string;
  line: number;
  lineCount: number;
  stale: boolean;
  /** First line number of `lines` (1-based). */
  start: number;
  lines: string[];
  /** The analyzed function whose range contains `line`, when there is one. */
  enclosing: {
    anchor: string;
    name: string;
    enclosingType: string | null;
    startLine: number;
    endLine: number;
    callers: SourcePartner[];
    callees: SourcePartner[];
    truncated: boolean;
  } | null;
}

export type SourceViewContentResult =
  | { ok: true; content: SourceViewContent }
  | { ok: false; reason: "not-utf8"; message: string };

/** Split exactly like the line counter (CRLF / LF / bare CR). */
export function splitSourceLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function repoRelative(ctx: AnalysisContext, path: string): string {
  return relative(ctx.repoPath, path).split(sep).join("/");
}

/** Innermost analyzed function whose 1-based range contains `line` in `file`. */
export function enclosingFunction(ctx: AnalysisContext, file: string, line: number): FunctionNode | null {
  let best: FunctionNode | null = null;
  for (const fn of ctx.functions) {
    if (!fn.id || repoRelative(ctx, fn.sourceRange.filePath) !== file) continue;
    const start = fn.sourceRange.start.line + 1;
    const end = fn.sourceRange.end.line + 1;
    if (line < start || line > end) continue;
    const span = end - start;
    if (!best || span < best.sourceRange.end.line - best.sourceRange.start.line) best = fn;
  }
  return best;
}

async function partners(ctx: AnalysisContext, id: AnchorId, direction: "in" | "out"): Promise<SourcePartner[]> {
  const nodes = direction === "in"
    ? await ctx.graph.predecessors(id, "calls")
    : await ctx.graph.neighbors(id, "calls");
  return nodes
    .filter((node) => node.id !== id)
    .map((node) => ({
      anchor: node.id,
      name: node.name,
      file: repoRelative(ctx, node.sourceRange.filePath),
      line: node.sourceRange.start.line + 1,
    }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line);
}

export async function buildSourceViewContent(
  ctx: AnalysisContext,
  target: SourceTarget,
): Promise<SourceViewContentResult> {
  const bytes = await readFile(target.absolutePath);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "not-utf8", message: "UTF-8 として読めないファイルのため表示できません。" };
  }
  const all = splitSourceLines(text.replace(/^﻿/, ""));
  const start = Math.max(1, target.line - SOURCE_WINDOW.before);
  const end = Math.min(all.length, target.line + SOURCE_WINDOW.after);

  const fn = enclosingFunction(ctx, target.file, target.line);
  let enclosing: SourceViewContent["enclosing"] = null;
  if (fn?.id) {
    const callers = await partners(ctx, fn.id, "in");
    const callees = await partners(ctx, fn.id, "out");
    enclosing = {
      anchor: fn.id,
      name: fn.name,
      enclosingType: fn.enclosingType ?? null,
      startLine: fn.sourceRange.start.line + 1,
      endLine: fn.sourceRange.end.line + 1,
      callers: callers.slice(0, PARTNER_LIMIT),
      callees: callees.slice(0, PARTNER_LIMIT),
      truncated: callers.length > PARTNER_LIMIT || callees.length > PARTNER_LIMIT,
    };
  }

  return {
    ok: true,
    content: {
      file: target.file,
      line: target.line,
      lineCount: target.lineCount,
      stale: target.stale,
      start,
      lines: all.slice(start - 1, end),
      enclosing,
    },
  };
}
