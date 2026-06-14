/**
 * Tests for T24 — semantic.ts
 * Uses a deterministic mock embedding client — no real API calls.
 */

import { describe, it, expect, afterEach } from "vitest";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpecClause } from "../types.js";
import type { EmbeddingClient } from "./semantic.js";
import { findSemanticLinks } from "./semantic.js";

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

// ---------------------------------------------------------------------------
// Mock embedding client
// ---------------------------------------------------------------------------

const KEYWORDS = ["hash", "parse", "dag", "spec", "link", "node", "graph"];

/**
 * Keyword-presence mock: position i = 1.0 if keyword[i] appears in the text.
 * Produces parallel vectors so cosine similarity is meaningful.
 */
const mockEmbedClient: EmbeddingClient = async (texts: string[]): Promise<number[][]> => {
  return texts.map((text) => {
    const lower = text.toLowerCase();
    return KEYWORDS.map((k) => (lower.includes(k) ? 1 : 0));
  });
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("findSemanticLinks", () => {
  it("finds a semantic link between a 'hash' clause and hash.ts", async () => {
    const clause = makeClause("cl-hash", "hash function", "The hash function computes values.");
    const codeFile = await writeTmp("hash.ts", "export function hashFunction() {}");

    const links = await findSemanticLinks([clause], [codeFile], mockEmbedClient, 0.3);

    expect(links.some((l) => l.to === "cl-hash" && l.evidence === "semantic")).toBe(true);
  });

  it("fills clause.embedding after the call", async () => {
    const clause = makeClause("cl-emb", "hash", "hash content");
    const codeFile = await writeTmp("hash3.ts", "function hash() {}");

    await findSemanticLinks([clause], [codeFile], mockEmbedClient);

    expect(clause.embedding).not.toBeNull();
    expect(Array.isArray(clause.embedding)).toBe(true);
    expect(clause.embedding!.length).toBe(KEYWORDS.length);
  });

  it("does not create a link for unrelated clause and file", async () => {
    const clause = makeClause("cl-unrelated", "database migration", "SQL schema procedures.");
    const codeFile = await writeTmp("renderer.ts", "export function renderFrame() {}");

    const links = await findSemanticLinks([clause], [codeFile], mockEmbedClient, 0.3);

    // With keyword-mock, neither text contains the same keywords → cosine similarity ≈ 0
    expect(links.filter((l) => l.to === "cl-unrelated")).toHaveLength(0);
  });

  it("custom threshold controls link emission", async () => {
    const clause = makeClause("cl-parse", "parse function", "The parse function processes spec files.");
    const codeFile = await writeTmp("parse.ts", "export function parse() {}");

    // High threshold — should not emit
    const linksHigh = await findSemanticLinks([clause], [codeFile], mockEmbedClient, 0.99);
    expect(linksHigh).toHaveLength(0);

    // Reset embedding (it was set by the call above)
    clause.embedding = null;

    // Low threshold — should emit
    const linksLow = await findSemanticLinks([clause], [codeFile], mockEmbedClient, 0.01);
    expect(linksLow.some((l) => l.to === "cl-parse")).toBe(true);
  });

  it("returns empty array when no clauses or code files provided", async () => {
    const a = await findSemanticLinks([], [], mockEmbedClient);
    expect(a).toHaveLength(0);

    const clause = makeClause("cl-x", "x", "x");
    const b = await findSemanticLinks([clause], [], mockEmbedClient);
    expect(b).toHaveLength(0);
  });
});
