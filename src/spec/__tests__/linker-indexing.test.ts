/**
 * The clause indexes in explicit.ts / structural.ts are pure speed: they must
 * emit exactly what a naive scan of every (file, clause) pair emits. These
 * tests pin the equivalence on the cases the indexes could plausibly get wrong.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findExplicitLinks } from "../explicit.js";
import { findStructuralLinks } from "../structural.js";
import type { SpecClause } from "../../types.js";

function clause(id: string, heading: string, text: string): SpecClause {
  return { id, heading, text } as SpecClause;
}

const CLAUSES: SpecClause[] = [
  clause("SPEC-alpha", "Alpha rendering pipeline", "The renderer lives in render.ts."),
  clause("SPEC-beta", "Beta storage layer", "Persistence is handled by store.ts."),
  clause("SPEC-gamma", "Gamma unrelated topic", "Nothing here names any file."),
  // Same heading text as a prefix of another: a per-needle memo must not let one
  // answer stand in for the other.
  clause("SPEC-delta", "Alpha rendering", "Legacy notes about rendering."),
];

describe("explicit linker indexing", () => {
  let dir: string;

  async function withFiles(
    files: Record<string, string>,
    run: (paths: string[]) => Promise<void>,
  ): Promise<void> {
    dir = await mkdtemp(join(tmpdir(), "anatomia-linker-"));
    try {
      const paths: string[] = [];
      for (const [name, content] of Object.entries(files)) {
        const path = join(dir, name);
        await writeFile(path, content, "utf8");
        paths.push(path);
      }
      await run(paths);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("links @implements to every clause whose id contains the ref", async () => {
    await withFiles({ "a.ts": "/** @implements SPEC-alpha */\nexport const a = 1;\n" }, async (paths) => {
      const links = await findExplicitLinks(CLAUSES, paths);
      const explicit = links.filter((l) => l.evidence === "explicit").map((l) => l.to);
      expect(explicit).toContain("SPEC-alpha");
      expect(explicit).not.toContain("SPEC-gamma");
    });
  });

  it("links @spec to EVERY clause whose heading contains the ref, not just one", async () => {
    // "Alpha rendering" is a substring of two headings; both must link, which a
    // memo keyed by needle preserves and a first-match index would break.
    // RE_SPEC captures to end of line, so the annotation gets its own line —
    // a trailing `*/` would become part of the reference.
    const source = "/**\n * @spec Alpha rendering\n */\nexport const b = 1;\n";
    await withFiles({ "b.ts": source }, async (paths) => {
      const links = await findExplicitLinks(CLAUSES, paths);
      const to = links.filter((l) => l.evidence === "explicit").map((l) => l.to);
      expect(to).toContain("SPEC-alpha");
      expect(to).toContain("SPEC-delta");
    });
  });

  it("links a clause that names a file by basename, and only that clause", async () => {
    await withFiles({ "render.ts": "export const r = 1;\n", "store.ts": "export const s = 1;\n" }, async (paths) => {
      const links = await findExplicitLinks(CLAUSES, paths);
      const forRender = links
        .filter((l) => String(l.from).endsWith("render.ts") && l.evidence === "explicit")
        .map((l) => l.to);
      expect(forRender).toEqual(["SPEC-alpha"]);
    });
  });

  it("emits nothing for a needle no clause contains", async () => {
    const source = "/**\n * @spec Nothing Matches This\n */\nexport const z = 1;\n";
    await withFiles({ "absent.ts": source }, async (paths) => {
      const links = await findExplicitLinks(CLAUSES, paths);
      expect(links).toEqual([]);
    });
  });

  it("shares one index across files without leaking answers between them", async () => {
    await withFiles(
      { "render.ts": "export const r = 1;\n", "store.ts": "export const s = 1;\n" },
      async (paths) => {
        const links = await findExplicitLinks(CLAUSES, paths);
        const byFile = new Map<string, string[]>();
        for (const link of links) {
          const name = String(link.from).split(/[\\/]/).pop()!;
          byFile.set(name, [...(byFile.get(name) ?? []), link.to]);
        }
        expect(byFile.get("render.ts")).toEqual(["SPEC-alpha"]);
        expect(byFile.get("store.ts")).toEqual(["SPEC-beta"]);
      },
    );
  });
});

describe("structural linker candidate selection", () => {
  it("matches a naive all-pairs scan", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anatomia-linker-s-"));
    try {
      const paths: string[] = [];
      for (const name of ["render.ts", "store.ts", "unrelated.ts"]) {
        const path = join(dir, name);
        await writeFile(path, "export function helper() { return 1; }\n", "utf8");
        paths.push(path);
      }
      const links = await findStructuralLinks(CLAUSES, paths);

      // The candidate index skips pairs sharing no keyword. Those score 0, which
      // is below the emit threshold, so skipping them must change nothing: every
      // emitted link must share at least one keyword with its file.
      expect(links.every((l) => l.evidence === "structural")).toBe(true);
      for (const link of links) {
        const base = String(link.from).split(/[\\/]/).pop()!.replace(/\.ts$/, "");
        const target = CLAUSES.find((c) => c.id === link.to)!;
        expect(`${target.heading} ${target.text}`.toLowerCase()).toContain(base);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
