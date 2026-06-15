/**
 * self-analyze.mjs — Part B: run Anatomia's full pipeline on Anatomia's own
 * TypeScript source (src/, excluding __tests__).
 *
 * Produces a JSON report used to write docs/self-analysis.md.
 *
 * Run after `npm run build`:
 *   node scripts/self-analyze.mjs
 *
 * The __tests__ directories are deliberately excluded so the analysis targets
 * production modules only; test files contain many near-duplicate snippets that
 * would inflate collision numbers without meaningful signal.
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, extname, basename, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "../dist/dag/parser.js";
import { extractFunctions } from "../dist/dag/extract.js";
import { normalize } from "../dist/dag/normalize.js";
import { assignAnchorId } from "../dist/dag/hash.js";
import { analyze, buildVerdict } from "../dist/core.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dir, "..");
const SRC_DIR = join(REPO_ROOT, "src");

// ---------------------------------------------------------------------------
// File collection (exclude __tests__, *.d.ts, dist, node_modules)
// ---------------------------------------------------------------------------

function shouldSkip(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.endsWith(".d.ts")) return true;
  const parts = normalized.split("/");
  return parts.some((p) => p === "__tests__" || p === "dist" || p === "node_modules");
}

async function collectTs(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = extname(e.name).toLowerCase();
    if (ext !== ".ts" && ext !== ".tsx") continue;
    const parent = e.parentPath ?? e.path ?? dir;
    const full = join(parent, e.name);
    if (!shouldSkip(full)) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hash helper — filePath must match the original to get comparable hashes,
// since assignAnchorId folds the file path into the hash input.
// ---------------------------------------------------------------------------

async function hashSnippet(text, lang = "typescript", filePath = "<snippet>") {
  const tree = await parse(text, lang);
  const fns = extractFunctions(tree, text, filePath);
  if (fns.length === 0) return null;
  const fn = fns[0];
  return assignAnchorId(fn, normalize(fn.bodyAst));
}

// ---------------------------------------------------------------------------
// Perturbation helpers (same-meaning → should keep hash)
// ---------------------------------------------------------------------------

function insertComment(t) {
  const idx = t.indexOf("{");
  if (idx < 0) return null;
  return t.slice(0, idx + 1) + " /* anatomia-probe */ " + t.slice(idx + 1);
}

function stripTsTypes(t) {
  // Very naive: remove `: Type` annotations — this changes types so hash should differ.
  // Used as a mutation test, NOT a same-meaning transform.
  return t.replace(/:\s*\w+(\[\])?\s*(?=[,)=])/g, "");
}

// ---------------------------------------------------------------------------
// Complexity proxy: count AST nodes in the normalized body string
// (number of opening parens in the S-expression ≈ node count)
// ---------------------------------------------------------------------------

function complexityProxy(normStr) {
  let count = 0;
  for (const ch of normStr) if (ch === "(") count++;
  return count;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const report = {};

  // ── Phase 1: file collection ──────────────────────────────────────────────
  const allFiles = await collectTs(SRC_DIR);
  report.fileCollection = {
    srcDir: SRC_DIR.replace(/\\/g, "/"),
    tsFilesFound: allFiles.length,
    note: "excludes __tests__ directories and *.d.ts files",
  };

  // ── Phase 2: parse + extract + hash (manual, so we can collect per-fn data) ─
  const parsed = [];
  const skipped = [];
  const records = []; // { name, file, relFile, hash, normLen, complexity }

  for (const filePath of allFiles) {
    let src;
    try {
      src = await readFile(filePath, "utf8");
    } catch (err) {
      skipped.push({ filePath, reason: "read: " + String(err) });
      continue;
    }
    const ext = extname(filePath).toLowerCase();
    const lang = ext === ".tsx" ? "tsx" : "typescript";
    let tree;
    try {
      tree = await parse(src, lang);
    } catch (err) {
      skipped.push({ filePath, reason: "parse: " + String(err) });
      continue;
    }
    parsed.push(filePath);
    const fns = extractFunctions(tree, src, filePath);
    for (const fn of fns) {
      try {
        const norm = normalize(fn.bodyAst);
        const h = assignAnchorId(fn, norm);
        records.push({
          name: fn.name,
          file: filePath.replace(/\\/g, "/"),
          relFile: relative(REPO_ROOT, filePath).replace(/\\/g, "/"),
          hash: h,
          normLen: norm.length,
          complexity: complexityProxy(norm),
        });
      } catch {
        // Skip functions that fail normalization.
      }
    }
  }

  report.coverage = {
    tsFilesParsed: parsed.length,
    tsFilesSkipped: skipped.length,
    functionsExtracted: records.length,
  };

  if (skipped.length > 0) {
    report.skippedFiles = skipped;
  }

  // ── Phase 3: hash measurement (same-meaning perturbations) ───────────────
  // We run on raw source snippets — re-read the file, find the first function per file.
  let commentOk = 0, commentBad = 0, commentSkip = 0;
  let commentExamples = [];

  for (const rec of records.slice(0, Math.min(records.length, 200))) {
    // We need the source text for the function. Use re-parse approach on the file.
    let src;
    try {
      src = await readFile(rec.file, "utf8");
    } catch { commentSkip++; continue; }
    const ext = extname(rec.file).toLowerCase();
    const lang = ext === ".tsx" ? "tsx" : "typescript";
    let tree;
    try { tree = await parse(src, lang); } catch { commentSkip++; continue; }
    const fns = extractFunctions(tree, src, rec.file);
    const fn = fns.find((f) => f.name === rec.name);
    if (!fn) { commentSkip++; continue; }

    // Slice out the full text for this function definition.
    const { start, end } = fn.sourceRange;
    const lines = src.split(/\r?\n/);
    let defLines = [];
    for (let i = start.line; i <= end.line; i++) {
      if (i === start.line && i === end.line) {
        defLines.push(lines[i].slice(start.column, end.column));
      } else if (i === start.line) {
        defLines.push(lines[i].slice(start.column));
      } else if (i === end.line) {
        defLines.push(lines[i].slice(0, end.column));
      } else {
        defLines.push(lines[i]);
      }
    }
    const def = defLines.join("\n");

    // Insert comment — should NOT change hash.
    // IMPORTANT: pass the real filePath so assignAnchorId produces the same
    // hash domain as the stored rec.hash (file path is folded into the hash).
    const withComment = insertComment(def);
    if (!withComment) { commentSkip++; continue; }
    let h2;
    try { h2 = await hashSnippet(withComment, lang, rec.file); } catch { commentSkip++; continue; }
    if (h2 === null) { commentSkip++; continue; }
    if (h2 === rec.hash) {
      commentOk++;
    } else {
      commentBad++;
      if (commentExamples.length < 3) commentExamples.push(rec.relFile + ":" + rec.name);
    }
  }

  const commentTotal = commentOk + commentBad;
  report.hashMeasurement = {
    commentInsertion: {
      ok: commentOk,
      bad: commentBad,
      skip: commentSkip,
      falseInvalidationRate: commentTotal === 0 ? 0 : commentBad / commentTotal,
      note: "same-meaning: insert a comment → hash must not change",
      badExamples: commentExamples,
    },
  };

  // ── Collision rate ─────────────────────────────────────────────────────────
  const normWs = (s) => s.replace(/\s+/g, " ").trim();
  const byHash = new Map();
  for (const r of records) {
    if (!byHash.has(r.hash)) byHash.set(r.hash, []);
    byHash.get(r.hash).push(r);
  }
  // For collision, we need bodies — rebuild from records (use normLen as proxy for distinctness).
  // A simpler approach: group by hash, see if multiple distinct names/files share a hash.
  let collidingPairs = 0;
  const collisionGroups = [];
  for (const [h, group] of byHash) {
    const distinctKeys = new Set(group.map((g) => g.relFile + ":" + g.name));
    if (distinctKeys.size > 1) {
      collidingPairs += (distinctKeys.size * (distinctKeys.size - 1)) / 2;
      collisionGroups.push({
        hash: h,
        members: [...distinctKeys].slice(0, 5),
        distinctFunctions: distinctKeys.size,
      });
    }
  }
  const distinctFns = records.length;
  const totalPairs = (distinctFns * (distinctFns - 1)) / 2;
  report.hashMeasurement.falseCollisionRate = {
    hashBuckets: byHash.size,
    distinctFunctions: distinctFns,
    collidingGroups: collisionGroups.length,
    collidingPairs,
    totalPairs,
    rate: totalPairs === 0 ? 0 : collidingPairs / totalPairs,
    collisionExamples: collisionGroups.slice(0, 5),
  };

  // ── Phase 4: full analyze() on src/ (for graph + domain detection) ─────────
  // analyze() uses SOURCE_EXTS which now includes .ts/.tsx, but we need to pass
  // a dir that only has TS files. We use SRC_DIR — it also has no C++ files.
  // To exclude __tests__, we can't directly filter inside analyze(), so we
  // use its `skipped` output to understand what it touched.
  const ctx = await analyze(SRC_DIR, { quiet: true });
  const allNodes = await ctx.graph.allNodes();
  let totalEdges = 0;
  for (const n of allNodes) {
    const edges = await ctx.graph.edgesFrom(n.id);
    totalEdges += edges.length;
  }

  report.analyzeResult = {
    functionsInGraph: ctx.functions.length,
    graphNodes: allNodes.length,
    graphEdges: totalEdges,
    specClauses: (ctx.specClauses ?? []).length,
    specLinks: (ctx.links ?? []).length,
    skippedByAnalyze: (ctx.skipped ?? []).length,
    domains: (ctx.domains ?? []).map((d) => ({
      domain: d.domain,
      implementors: d.implementors.length,
      violations: d.violations.length,
    })),
  };

  // ── Phase 5: complexity / coupling hotspots ────────────────────────────────
  // Use our complexity proxy (AST node count from S-expression) to rank functions.
  const sorted = [...records].sort((a, b) => b.complexity - a.complexity);
  report.hotspots = {
    topComplexByAstNodes: sorted.slice(0, 12).map((r) => ({
      function: r.name,
      file: r.relFile,
      astNodeCount: r.complexity,
    })),
  };

  // Coupling: approximate fan-out per function from graph edges.
  const couplingRows = [];
  for (const fn of ctx.functions) {
    if (!fn.id) continue;
    const edges = await ctx.graph.edgesFrom(fn.id);
    if (edges.length > 0) {
      couplingRows.push({
        function: fn.name,
        file: relative(REPO_ROOT, fn.sourceRange.filePath).replace(/\\/g, "/"),
        fanOut: edges.length,
      });
    }
  }
  couplingRows.sort((a, b) => b.fanOut - a.fanOut);
  report.hotspots.topCouplingByFanOut = couplingRows.slice(0, 10);

  // ── Phase 6: synthetic verify ──────────────────────────────────────────────
  // Inject a trivial TypeScript function as a "diff" and verify against the
  // TS context. Note: buildVerdict() currently parses as C++; we call the
  // pipeline manually for TS.
  const syntheticTs = `
    function hashCanonical(normalized: string): string {
      const digest = crypto.createHash("sha256").update(normalized).digest("hex");
      return digest.slice(0, 16);
    }
  `;
  // Use the C++ buildVerdict path (it parses as C++ — will work on a simple snippet
  // that looks like a function).
  let verifyResult = null;
  try {
    // Feed as raw source (not a diff). buildVerdict falls back to treating non-diff input as-is.
    const v = await buildVerdict(ctx, syntheticTs);
    verifyResult = {
      pass: v.pass,
      gates: v.gates.map((g) => ({ gate: g.gate, pass: g.pass })),
      suggestion: v.suggestion,
    };
  } catch (err) {
    verifyResult = { error: String(err) };
  }
  report.verify = verifyResult;

  // ── Output ─────────────────────────────────────────────────────────────────
  console.log(JSON.stringify(report, null, 2));
  return report;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
