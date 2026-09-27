import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AnalysisContext } from "../core.js";

export interface LocatorComments { comments: Map<string, string>; unavailable: string[] }

/** Read bounded source comments during explicit preparation, never on a query. */
export async function readLocatorComments(ctx: AnalysisContext): Promise<LocatorComments> {
  const byPath = new Map<string, Set<number>>();
  for (const fn of ctx.functions) {
    const path = isAbsolute(fn.sourceRange.filePath)
      ? relative(ctx.repoPath, fn.sourceRange.filePath).replace(/\\/g, "/")
      : fn.sourceRange.filePath.replace(/\\/g, "/");
    const lines = byPath.get(path) ?? new Set<number>();
    lines.add(fn.sourceRange.start.line);
    byPath.set(path, lines);
  }
  const comments = new Map<string, string>();
  const unavailable: string[] = [];
  const paths = [...byPath.keys()];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, paths.length) }, async () => {
    while (next < paths.length) {
      const path = paths[next++];
      if (!path) continue;
      const absolute = resolve(ctx.repoPath, path);
      if (isAbsolute(path) || path.startsWith("..") || !absolute.startsWith(resolve(ctx.repoPath) + sep)) {
        unavailable.push(`${path}: outside repository`);
        continue;
      }
      let lines: string[];
      try { lines = (await readFile(absolute, "utf8")).split(/\r?\n/); }
      catch (error) { unavailable.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); continue; }
      for (const line of byPath.get(path) ?? []) {
        const block: string[] = [];
        for (let i = line - 1; i >= Math.max(0, line - 8); i--) {
          const raw = lines[i]?.trim() ?? "";
          if (!/^(\/\/|\/\*|\*|\*\/)/.test(raw)) break;
          block.unshift(raw.replace(/^(\/\/\/ ?|\/\/ ?|\/\*\*? ?|\*\/? ?)/, ""));
        }
        const value = block.join(" ").trim().slice(0, 300);
        if (value) comments.set(`${path}\0${line}`, value);
      }
    }
  }));
  return { comments, unavailable };
}
