/**
 * T24 — Semantic (embedding-based) linker.
 * Uses an injected EmbeddingClient to compute cosine similarity between
 * spec clauses and code files.  No real API calls in this module itself.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { AnchorId, Link, SpecClause } from "../types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Inject any embedding provider — the module never calls an API directly. */
export type EmbeddingClient = (texts: string[]) => Promise<number[][]>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFileAnchor(filePath: string): AnchorId {
  return filePath as unknown as AnchorId;
}

/** Cosine similarity between two equal-length numeric vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Build a short textual summary for a code file. */
async function codeSummary(filePath: string): Promise<string> {
  const name = basename(filePath);
  try {
    const content = await readFile(filePath, "utf8");
    return `${name} ${content.slice(0, 200)}`;
  } catch {
    return name;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLD = 0.3;

/**
 * Find semantic links using injected embedding client + cosine similarity.
 *
 * Side-effect: fills `clause.embedding` for each clause with its embedding
 * vector from the first embedding batch.
 *
 * @param clauses     Parsed spec clauses.
 * @param codeFiles   Absolute paths to source files.
 * @param embedClient Injected embedding function — accepts batches of strings.
 * @param threshold   Minimum cosine similarity to emit a link (default 0.3).
 */
export async function findSemanticLinks(
  clauses: SpecClause[],
  codeFiles: string[],
  embedClient: EmbeddingClient,
  threshold = DEFAULT_THRESHOLD,
): Promise<Link[]> {
  if (clauses.length === 0 || codeFiles.length === 0) return [];

  // Step 1 — embed all clause texts.
  const clauseTexts = clauses.map((c) => `${c.heading} ${c.text}`);
  const clauseEmbeddings = await embedClient(clauseTexts);

  // Fill clause.embedding as side effect.
  for (let i = 0; i < clauses.length; i++) {
    clauses[i].embedding = clauseEmbeddings[i] ?? null;
  }

  // Step 2 — build code summaries and embed them.
  const summaries = await Promise.all(codeFiles.map(codeSummary));
  const codeEmbeddings = await embedClient(summaries);

  // Step 3 — compute cosine similarity and emit links.
  const links: Link[] = [];

  for (let ci = 0; ci < clauses.length; ci++) {
    const ce = clauseEmbeddings[ci];
    if (!ce) continue;

    for (let fi = 0; fi < codeFiles.length; fi++) {
      const fe = codeEmbeddings[fi];
      if (!fe) continue;

      const sim = cosineSimilarity(ce, fe);
      if (sim >= threshold) {
        links.push({
          from: makeFileAnchor(codeFiles[fi]),
          to: clauses[ci].id,
          confidence: sim,
          evidence: "semantic",
        });
      }
    }
  }

  return links;
}
