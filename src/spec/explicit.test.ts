/**
 * Tests for T22 — explicit.ts
 */

import { describe, it, expect, afterEach } from "vitest";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpecClause } from "../types.js";
import { findExplicitLinks } from "./explicit.js";

const TMP = tmpdir();
const tempFiles: string[] = [];

async function writeTmp(name: string, content: string): Promise<string> {
  const p = join(TMP, name);
  await writeFile(p, content, "utf8");
  tempFiles.push(p);
  return p;
}

afterEach(async () => {
  await Promise.allSettled(tempFiles.map((f) => unlink(f)));
  tempFiles.length = 0;
});

function makeClause(overrides: Partial<SpecClause> = {}): SpecClause {
  return {
    id: "SPEC-abc123",
    sourceFile: "spec/design.md",
    heading: "§4.5 / リンカ",
    text: "The linker merges object files.",
    embedding: null,
    ...overrides,
  };
}

describe("findExplicitLinks — @implements annotation", () => {
  it("creates a link when code file contains @implements SPEC-abc123", async () => {
    const clause = makeClause({ id: "SPEC-abc123" });
    const codeFile = await writeTmp("code1.ts", [
      "// @implements SPEC-abc123",
      "export function doThing() {}",
    ].join("\n"));

    const links = await findExplicitLinks([clause], [codeFile]);

    expect(links).toHaveLength(1);
    expect(links[0].to).toBe("SPEC-abc123");
    expect(links[0].from).toBe(codeFile as unknown as string);
    expect(links[0].evidence).toBe("explicit");
    expect(links[0].confidence).toBe(1.0);
  });

  it("emits no link when @implements targets a different id", async () => {
    const clause = makeClause({ id: "SPEC-zzzzzz" });
    const codeFile = await writeTmp("code2.ts", "// @implements SPEC-abc123\nexport function foo() {}");

    const links = await findExplicitLinks([clause], [codeFile]);
    expect(links).toHaveLength(0);
  });
});

describe("findExplicitLinks — @spec annotation", () => {
  it("creates a link when @spec matches clause heading text", async () => {
    const clause = makeClause({ id: "clause-001", heading: "§4.5" });
    const codeFile = await writeTmp("code3.ts", [
      "// @spec §4.5",
      "export function link() {}",
    ].join("\n"));

    const links = await findExplicitLinks([clause], [codeFile]);

    expect(links.some((l) => l.to === "clause-001" && l.evidence === "explicit")).toBe(true);
  });

  it("creates a link when @spec text matches heading substring", async () => {
    const clause = makeClause({ id: "clause-002", heading: "Linker phase" });
    const codeFile = await writeTmp("code4.ts", "// @spec Linker phase\nexport function x() {}");

    const links = await findExplicitLinks([clause], [codeFile]);
    expect(links.some((l) => l.to === "clause-002")).toBe(true);
  });
});

describe("findExplicitLinks — spec text references code file basename", () => {
  it("creates a link when spec clause text mentions the code file basename", async () => {
    const codeFile = await writeTmp("tier-routing.ts", "export function route() {}");
    const clause = makeClause({
      id: "clause-003",
      text: "See tier-routing.ts for the routing implementation.",
    });

    const links = await findExplicitLinks([clause], [codeFile]);

    expect(links.some((l) => l.to === "clause-003" && l.from === (codeFile as unknown as string))).toBe(true);
  });

  it("does not create a link when no match exists", async () => {
    const codeFile = await writeTmp("unrelated-file.ts", "export function nothing() {}");
    const clause = makeClause({ id: "clause-004", text: "This clause mentions nothing relevant." });

    const links = await findExplicitLinks([clause], [codeFile]);
    // "nothing" in both file name and text — actually check carefully.
    // "unrelated-file.ts" basename is "unrelated-file.ts", text does not contain that literally
    expect(links.filter((l) => l.to === "clause-004" && l.from === (codeFile as unknown as string) && l.evidence === "explicit" && l.confidence === 1.0)).toHaveLength(0);
  });
});
