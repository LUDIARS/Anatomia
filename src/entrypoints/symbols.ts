/**
 * src/entrypoints/symbols.ts — The symbol view detectors resolve names against.
 *
 * Detectors read source TEXT (a route table, a `case "verb":`, a `client.on`
 * registration) and recover a handler NAME. Turning that name into an anchor is
 * the same problem for every detector, so it lives here once — with a
 * conservative resolution order: same file wins, then a repo-unique name; an
 * ambiguous name resolves to nothing rather than to an arbitrary pick (a wrong
 * entry root would mis-attribute a whole subtree).
 *
 * SRP: symbol indexing + name resolution. No detection heuristics.
 */

import { relative } from "node:path";
import type { AnchorId, FunctionNode } from "../types.js";
import type { EntryPointSymbol } from "./types.js";
import { isTestPath } from "./config.js";

/** A function as detectors see it: anchor + name + repo-relative location. */
export interface IndexedSymbol extends EntryPointSymbol {
  /** Absolute path, for matching against FileNode/ScreenNode records. */
  absolutePath: string;
  enclosingType?: string;
}

export class SymbolIndex {
  /** Every anchored function, sorted by (path, line, name). */
  readonly all: IndexedSymbol[];
  private readonly byAnchor = new Map<string, IndexedSymbol>();
  private readonly byPath = new Map<string, IndexedSymbol[]>();
  private readonly byName = new Map<string, IndexedSymbol[]>();

  constructor(repoPath: string, functions: readonly FunctionNode[]) {
    this.all = functions
      .filter((fn): fn is FunctionNode & { id: AnchorId } => fn.id !== null && fn.id !== undefined)
      .map((fn) => ({
        anchor: fn.id,
        name: fn.name,
        path: relative(repoPath, fn.sourceRange.filePath).replace(/\\/g, "/"),
        line: fn.sourceRange.start.line,
        absolutePath: fn.sourceRange.filePath,
        ...(fn.enclosingType ? { enclosingType: fn.enclosingType } : {}),
      }))
      .sort((left, right) =>
        left.path.localeCompare(right.path)
        || left.line - right.line
        || left.name.localeCompare(right.name)
        || String(left.anchor).localeCompare(String(right.anchor)));
    for (const symbol of this.all) {
      this.byAnchor.set(String(symbol.anchor), symbol);
      (this.byPath.get(symbol.path) ?? this.byPath.set(symbol.path, []).get(symbol.path)!).push(symbol);
      (this.byName.get(symbol.name) ?? this.byName.set(symbol.name, []).get(symbol.name)!).push(symbol);
    }
  }

  get(anchor: string): IndexedSymbol | undefined {
    return this.byAnchor.get(anchor);
  }

  inFile(relPath: string): IndexedSymbol[] {
    return this.byPath.get(relPath) ?? [];
  }

  /** Symbols outside test sources — the set convention detectors may see. */
  conventionScope(includeTests: boolean): IndexedSymbol[] {
    return includeTests ? this.all : this.all.filter((symbol) => !isTestPath(symbol.path));
  }

  /**
   * Resolve a handler name to one symbol: same file first, then repo-unique.
   * Ambiguous → undefined (a guessed root is worse than a missing one).
   */
  resolve(name: string, preferredPath?: string): IndexedSymbol | undefined {
    const candidates = this.byName.get(name) ?? [];
    if (candidates.length === 0) return undefined;
    if (preferredPath !== undefined) {
      const sameFile = candidates.filter((symbol) => symbol.path === preferredPath);
      if (sameFile.length === 1) return sameFile[0];
      if (sameFile.length > 1) return undefined;
    }
    return candidates.length === 1 ? candidates[0] : undefined;
  }
}
