/**
 * T34 — C++ scope marker codegen.
 */
import { readFileSync } from 'node:fs';
import type { AnchorId, AstNode, FunctionNode } from '../types.js';

// The recorder itself is a committed, reusable library — runtime/cpp/
// anatomia_trace.hpp is the single source of truth (usable by games directly).
// `trace plan` embeds that exact file so the emitted anatomia_zones.h stays
// standalone. Read once per process; src/dynamic and dist/dynamic sit at the
// same depth, so one relative URL serves both.
let cachedCppRuntime: string | undefined;
function cppRuntimeLibrary(): string {
  cachedCppRuntime ??= readFileSync(
    new URL('../../runtime/cpp/anatomia_trace.hpp', import.meta.url),
    'utf8',
  );
  return cachedCppRuntime;
}

export function generateCppHeader(enabled: boolean): string {
  if (enabled) {
    // A measurement build emits one TraceEvent per line to $ANATOMIA_TRACE_FILE
    // (recording is OFF when the env var is unset). The events match
    // dynamic/protocol.ts exactly so ingest.ts can read them back. Zone markers
    // carry the AnchorId baked in at injection time.
    return cppRuntimeLibrary();
  }
  return `#pragma once
// Anatomia measurement instrumentation header (disabled).
// Compile with ANATOMIA_MEASUREMENT_BUILD to enable zone + frame markers.

#define ANATOMIA_ZONE(name, anchorId) /* no-op */
#define ANATOMIA_FRAME_BEGIN(id) /* no-op */
#define ANATOMIA_FRAME_END(id) /* no-op */
`;
}

export interface DomainEntryPoint {
  filePath: string;
  line: number;
  anchorId: AnchorId;
  name: string;
}

export interface InjectionPatch {
  filePath: string;
  line: number;
  code: string;
}

export function generateCppPatches(entryPoints: DomainEntryPoint[]): InjectionPatch[] {
  return entryPoints.map((ep) => ({
    filePath: ep.filePath,
    line: ep.line,
    code: `ANATOMIA_ZONE("${ep.name}", "${ep.anchorId}");`,
  }));
}

// ---------------------------------------------------------------------------
// Frame-marker auto-detection (#347)
// ---------------------------------------------------------------------------

/** Heuristic function names that identify a game's main loop. */
const MAIN_LOOP_HEURISTIC_NAMES = new Set<string>([
  "main", "run", "Run", "loop", "Loop",
  "gameLoop", "GameLoop", "mainLoop", "MainLoop", "tick",
]);

/**
 * Source location of a detected main-loop function, with frame-marker
 * insertion lines pre-computed for ANATOMIA_FRAME_BEGIN / FRAME_END.
 */
export interface MainLoopCandidate {
  filePath: string;
  /** 0-based source line for ANATOMIA_FRAME_BEGIN insertion. */
  frameBeginLine: number;
  /** 0-based source line for ANATOMIA_FRAME_END insertion (before closing brace). */
  frameEndLine: number;
  name: string;
  anchorId: AnchorId;
  /**
   * "loop-body" — frame markers target the inner while/for body (precise);
   * "function"  — fallback to function-boundary lines when no loop is found.
   */
  precision: "loop-body" | "function";
}

/**
 * Scan a function body AST for its first top-level loop statement and return
 * the loop body's source range. Returns null when no while/for loop is found.
 */
function findTopLoopBounds(
  bodyNode: AstNode,
): { startLine: number; endLine: number } | null {
  for (let i = 0; i < bodyNode.childCount; i++) {
    const child = bodyNode.child(i);
    if (!child) continue;
    const t = child.type;
    if (
      t === "while_statement" ||
      t === "for_statement" ||
      t === "for_range_loop" ||
      t === "do_statement"
    ) {
      const body = child.childForFieldName("body");
      if (body) {
        return { startLine: body.startPosition.row, endLine: body.endPosition.row };
      }
    }
  }
  return null;
}

/**
 * Detect main-loop candidate functions from the analyzed function list.
 *
 * Pass `mainLoopHint` (a function name, case-insensitive) to identify the
 * main loop explicitly; omit it to fall back to the heuristic name set
 * (`main`, `run`, `loop`, `tick`, etc.).
 *
 * For each candidate, the function's body AST is scanned for a top-level
 * while/for loop so that frame markers land at the loop body boundaries
 * (precision = "loop-body"). When no inner loop is found the function's own
 * source boundaries are used as a fallback (precision = "function").
 */
export function detectMainLoopCandidates(
  functions: FunctionNode[],
  mainLoopHint?: string,
): MainLoopCandidate[] {
  const isCandidate = mainLoopHint
    ? (fn: FunctionNode) => {
        const hint = mainLoopHint.toLowerCase();
        const name = fn.name.toLowerCase();
        return name === hint || name.endsWith(`::${hint}`);
      }
    : (fn: FunctionNode) => MAIN_LOOP_HEURISTIC_NAMES.has(fn.name);

  return functions
    .filter((fn) => fn.id !== null && isCandidate(fn))
    .map((fn) => {
      const loop = findTopLoopBounds(fn.bodyAst);
      if (loop) {
        return {
          filePath: fn.sourceRange.filePath,
          frameBeginLine: loop.startLine + 1,
          frameEndLine: loop.endLine,
          name: fn.name,
          anchorId: fn.id!,
          precision: "loop-body" as const,
        };
      }
      return {
        filePath: fn.sourceRange.filePath,
        frameBeginLine: fn.sourceRange.start.line + 1,
        frameEndLine: fn.sourceRange.end.line,
        name: fn.name,
        anchorId: fn.id!,
        precision: "function" as const,
      };
    });
}

/**
 * Generate ANATOMIA_FRAME_BEGIN / FRAME_END injection patches for main-loop
 * candidates detected by `detectMainLoopCandidates`. Returns two patches per
 * candidate (begin + end), suitable for the same patch-apply pipeline as
 * `generateCppPatches`.
 */
export function generateFrameMarkerPatches(candidates: MainLoopCandidate[]): InjectionPatch[] {
  const patches: InjectionPatch[] = [];
  for (const c of candidates) {
    patches.push(
      {
        filePath: c.filePath,
        line: c.frameBeginLine,
        code: `ANATOMIA_FRAME_BEGIN(/*frameId*/0); /* auto:${c.precision} */`,
      },
      {
        filePath: c.filePath,
        line: c.frameEndLine,
        code: `ANATOMIA_FRAME_END(/*frameId*/0); /* auto:${c.precision} */`,
      },
    );
  }
  return patches;
}
