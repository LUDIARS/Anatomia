/** Type declarations for the browser-served "open in Tela" panel logic. */

export interface SourceViewCandidateLike {
  anchor?: string;
  name: string;
  enclosingType: string | null;
  file: string;
  line: number;
}

export type SourceViewAction = "open-anyway" | "reanalyze" | "open-first-line" | "retry";

export interface SourceViewOutcome {
  tone: "ok" | "warn" | "error";
  text: string;
  location: string | null;
  actions: SourceViewAction[];
}

export function candidateLabel(candidate: SourceViewCandidateLike): string;
export function launchBody(
  candidate: Pick<SourceViewCandidateLike, "file" | "line">,
  acceptStale?: boolean,
): { file: string; line: number; acceptStale?: true };
export function launchOutcome(response: {
  ok?: boolean;
  reason?: string;
  message?: string;
  file?: string;
  line?: number;
  stale?: boolean;
} | null | undefined): SourceViewOutcome;
export function actionLabel(action: string): string;

export interface SourceViewContentLike {
  file: string;
  line: number;
  lineCount: number;
  start: number;
  lines: string[];
  enclosing: { startLine: number; endLine: number } | null;
}
export function codeRows(content: SourceViewContentLike): Array<{
  number: number;
  text: string;
  target: boolean;
  inFunction: boolean;
}>;
export function contentQuery(file: string, line: number): string;
export function pageLine(content: SourceViewContentLike, direction: "prev" | "next"): number;
