/**
 * Tests for T23 — structural.ts
 */

import { describe, it, expect, afterEach } from "vitest";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpecClause } from "../types.js";
import { findStructuralLinks } from "./structural.js";

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

function makeClause(id: string, heading: string, text: string): SpecClause {
  return { id, sourceFile: "spec/design.md", heading, text, embedding: null };
}

describe("findStructuralLinks", () => {
  it("detects structural link between 'hash function' clause and hash.ts", async () => {
    const clause = makeClause("cl-hash", "hash function", "The hash function computes SHA-256.");
    const codeFile = await writeTmp("hash.ts", "export function hashFunction(s: string) {}");

    const links = await findStructuralLinks([clause], [codeFile]);

    expect(links.some((l) => l.to === "cl-hash" && l.evidence === "structural")).toBe(true);
  });

  it("confidence for a matching link is in range [0.4, 0.8]", async () => {
    // Use basename "hash" which matches clause keyword "hash"
    const clause = makeClause("cl-hash3", "hash function", "SHA-256 based hash computation.");
    const codeFile = await writeTmp("hash-fn.ts", "export function hashFunction() {}");

    const links = await findStructuralLinks([clause], [codeFile]);
    const link = links.find((l) => l.to === "cl-hash3");
    expect(link).toBeDefined();
    expect(link!.confidence).toBeGreaterThanOrEqual(0.4);
    expect(link!.confidence).toBeLessThanOrEqual(0.8);
  });

  it("emits no link for totally unrelated clause and file", async () => {
    const clause = makeClause("cl-unrelated", "database migration", "SQL schema upgrade procedure.");
    const codeFile = await writeTmp("renderer.ts", "export function render() {}");

    const links = await findStructuralLinks([clause], [codeFile]);
    // Either no links OR below threshold — check none have confidence >= 0.4
    const highConf = links.filter((l) => l.to === "cl-unrelated" && l.confidence >= 0.4);
    expect(highConf).toHaveLength(0);
  });

  it("picks up exported symbol names from code file", async () => {
    const clause = makeClause("cl-export", "parseSpecFiles function", "parseSpecFiles aggregates clauses from many files.");
    const codeFile = await writeTmp("parse-spec.ts", [
      "export function parseSpecFiles(paths: string[]) { return []; }",
    ].join("\n"));

    const links = await findStructuralLinks([clause], [codeFile]);
    expect(links.some((l) => l.to === "cl-export" && l.evidence === "structural")).toBe(true);
  });
});
