/**
 * T44 — Measurement harness (run against a real repo).
 *
 * Produces the numbers in docs/measurement-report.md:
 *   1. Hash hit-rate on REAL functions:
 *      (a) stability   — re-parse identical source → unchanged
 *      (b) same-meaning perturbations (reformat / comment / rename-local) → unchanged
 *      (c) body mutations (add statement / swap operator) → updated
 *      (d) collisions  — no two distinct real functions share a hash
 *   2. Coverage      — files parsed/skipped, functions, graph nodes/edges,
 *                      domains detected, spec links
 *   3. Bundle determinism — assemble twice → identical
 *   4. Verify on a real synthetic diff → Verdict
 *
 * Usage:  node scripts/measure.mjs [root1 root2 ...]
 *   Defaults to the AdventureCube combat/skill/equipment subset.
 *
 * Honest by construction: it reports what actually happens, including the
 * confounds in the perturbation transforms (see report for interpretation).
 *
 * Run after `npm run build` (it imports from dist/).
 */

import { readdir, readFile } from "node:fs/promises";
import { join, extname, basename } from "node:path";

import { parse } from "../dist/dag/parser.js";
import { extractFunctions } from "../dist/dag/extract.js";
import { normalize } from "../dist/dag/normalize.js";
import { assignAnchorId } from "../dist/dag/hash.js";
import { analyze, buildContextBundle, buildVerdict } from "../dist/core.js";
import { parseSpecFiles } from "../dist/spec/parse.js";
import { findExplicitLinks } from "../dist/spec/explicit.js";
import { findStructuralLinks } from "../dist/spec/structural.js";
import { insertBodyComment, hashNamedSnippet } from "../dist/dag/measure.js";

/** Optional repo whose spec/ dir is linked against the analyzed code. */
const SPEC_REPO = process.env.ANATOMIA_SPEC_REPO || "E:/Document/Ars/AdventureCube";
const SPEC_DIR = SPEC_REPO + "/spec";

const DEFAULT_ROOTS = [
  "E:/Document/Ars/AdventureCube/src/combat",
  "E:/Document/Ars/AdventureCube/src/skill",
  "E:/Document/Ars/AdventureCube/src/equipment",
];
const SRC_EXTS = new Set([".cpp", ".h"]);

const roots = process.argv.slice(2);
const ROOTS = roots.length > 0 ? roots : DEFAULT_ROOTS;

async function collect(dir, exts) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!exts.has(extname(e.name).toLowerCase())) continue;
    out.push(join(e.parentPath ?? e.path ?? dir, e.name));
  }
  return out;
}

/**
 * Hash the named function (or outermost) found in a snippet, IN CONTEXT.
 * AST-aware + filePath-aware: delegates to the shared hashNamedSnippet so the
 * AnchorId hash domain — which folds the file path AND the enclosing scope from
 * normalizeSignatureShape — matches the stored record hash.
 */
async function hashSnippet(text, filePath = "<p>", name, occurrence) {
  return hashNamedSnippet(text, "cpp", name, filePath, occurrence);
}

const normWs = (s) => s.replace(/\s+/g, " ").trim();

function sliceDef(src, range) {
  const { start, end } = range;
  const lines = src.split(/\r?\n/);
  if (start.line === end.line) return lines[start.line].slice(start.column, end.column);
  const seg = [lines[start.line].slice(start.column)];
  for (let i = start.line + 1; i < end.line; i++) seg.push(lines[i]);
  seg.push(lines[end.line].slice(0, end.column));
  return seg.join("\n");
}

/** Convert a {line,column} position into a byte offset into `src`. */
function posToOffset(src, pos) {
  // Walk the real bytes so CRLF (2-byte) and LF (1-byte) terminators are both
  // counted correctly — tree-sitter positions are byte/char offsets into src.
  let off = 0, line = 0;
  while (line < pos.line && off < src.length) {
    const ch = src.charCodeAt(off);
    if (ch === 10) line++;            // 

    off++;
  }
  return off + pos.column;
}

/**
 * Replace the [startOff,endOff) slice of `src` with `newDef`, returning the
 * reconstructed FULL file. Hashing the named function from this reconstruction
 * preserves the enclosing namespace/class scope (which normalizeSignatureShape
 * folds into the AnchorId); a standalone slice would lose that scope and never
 * match the in-file hash.
 */
function spliceFullFile(src, startOff, endOff, newDef) {
  return src.slice(0, startOff) + newDef + src.slice(endOff);
}

// --- Perturbation transforms (same-meaning: must keep the hash) --------------
function reformat(t) {
  // NOTE: this naive transform also collapses whitespace INSIDE string literals,
  // which legitimately changes meaning. The report separates those out.
  return t.replace(/[ \t]+/g, " ").replace(/\n[ \t]*/g, "\n  ").replace(/\n{2,}/g, "\n");
}
// (insert-comments now uses the AST-aware insertBodyComment from dag/measure)

/**
 * AST-aware local rename: parse `t`, find a TRUE local variable (the identifier
 * bound by a declaration's init_declarator, NOT a field, type, or call name),
 * and rename every *plain identifier* use of that name (skipping field_identifier
 * `obj.name` and call callees). This isolates the property the normalizer
 * actually claims (α-rename of locals), without the confound of renaming members.
 * Returns null when no clean local can be found.
 */
async function renameLocals(t) {
  const tree = await parse(t, "cpp");
  const fns = extractFunctions(tree, t, "<p>");
  if (fns.length === 0) return null;
  const body = fns[0].bodyAst;

  // Find a declared local name (init_declarator → identifier).
  let localName = null;
  const stack = [body];
  while (stack.length) {
    const n = stack.pop();
    if (n.type === "init_declarator") {
      const d = n.childForFieldName("declarator");
      if (d && d.type === "identifier") { localName = d.text; break; }
    }
    for (const c of n.namedChildren) if (c) stack.push(c);
  }
  if (!localName) return null;

  // Collect byte ranges of plain `identifier` uses of localName that are NOT
  // a field name (`.name`) and NOT a call callee.
  const edits = [];
  const s2 = [body];
  while (s2.length) {
    const n = s2.pop();
    if (n.type === "identifier" && n.text === localName) {
      const p = n.parent;
      const isField = p && p.type === "field_expression" && p.childForFieldName("field") === n;
      const isCallee = p && p.type === "call_expression" && p.childForFieldName("function") === n;
      if (!isField && !isCallee) edits.push([n.startIndex, n.endIndex]);
    }
    for (const c of n.namedChildren) if (c) s2.push(c);
  }
  if (edits.length === 0) return null;

  // Apply edits right-to-left so offsets stay valid (offsets are into `t`).
  edits.sort((a, b) => b[0] - a[0]);
  let out = t;
  for (const [a, b] of edits) out = out.slice(0, a) + localName + "_r" + out.slice(b);
  return out === t ? null : out;
}
/** Whether a multi-space run appears inside a string literal in `t`. */
function hasMultiSpaceInString(t) {
  return /"[^"\n]*  [^"\n]*"/.test(t);
}

// --- Mutation transforms (body change: must change the hash) -----------------
/** Insert a statement just after the BODY's opening brace (not the sig/init). */
function bodyOpen(t) {
  const m = t.search(/\)\s*(?:\bconst\b|\bnoexcept\b|\boverride\b|\bfinal\b|\s)*\s*\{/);
  if (m >= 0) return t.indexOf("{", m);
  return t.indexOf("{");
}
function addStatement(t) {
  const i = bodyOpen(t);
  if (i < 0) return null;
  return t.slice(0, i + 1) + "\n int __anatomia_probe = 0; (void)__anatomia_probe;\n" + t.slice(i + 1);
}

async function main() {
  // ── Gather real functions ────────────────────────────────────────────────
  let files = [];
  for (const r of ROOTS) files = files.concat(await collect(r, SRC_EXTS));

  let parsed = 0;
  const skipped = [];
  const recs = []; // { name, file, def, hash, body, src, startOff, endOff }
  for (const f of files) {
    let src;
    try {
      src = await readFile(f, "utf8");
    } catch (err) {
      skipped.push([f, "read: " + String(err)]);
      continue;
    }
    let tree;
    try {
      tree = await parse(src, "cpp");
    } catch (err) {
      skipped.push([f, "parse: " + String(err)]);
      continue;
    }
    parsed++;
    const fns = extractFunctions(tree, src, f);
    // Source-order rank among same-named functions in this file (matches the
    // ordering pickFunction uses), so duplicate names are disambiguated.
    const ordered = fns.slice().sort((a, b) =>
      a.sourceRange.start.line - b.sourceRange.start.line ||
      a.sourceRange.start.column - b.sourceRange.start.column);
    const nameSeen = new Map();
    for (const fn of ordered) {
      const occurrence = nameSeen.get(fn.name) ?? 0;
      nameSeen.set(fn.name, occurrence + 1);
      let h;
      try {
        h = assignAnchorId(fn, normalize(fn.bodyAst));
      } catch {
        continue;
      }
      const startOff = posToOffset(src, fn.sourceRange.start);
      const endOff = posToOffset(src, fn.sourceRange.end);
      recs.push({ name: fn.name, file: f, def: sliceDef(src, fn.sourceRange), hash: h, body: fn.bodyAst.text, src, startOff, endOff, occurrence });
    }
  }

  const out = {};
  out.coverage = { filesTotal: files.length, parsed, skipped: skipped.length, functions: recs.length };

  // ── (a) stability ─────────────────────────────────────────────────────────
  // Re-hash each function IN CONTEXT (named function within its full file) so the
  // enclosing namespace/class scope folded into the AnchorId is preserved.
  let aOk = 0;
  for (const r of recs) {
    const h = await hashSnippet(r.src, r.file, r.name, r.occurrence);
    if (h === r.hash) aOk++;
  }
  out.stability = { ok: aOk, total: recs.length };

  // ── (b) same-meaning perturbations ────────────────────────────────────────
  // Each transform rewrites the function's DEF text; we splice it back into the
  // full file and re-hash the SAME named function in context (scope preserved).
  async function runSame(name, transform, classify) {
    let ok = 0, bad = 0, skip = 0, badArtifact = 0;
    const ex = [];
    for (const r of recs) {
      let tt;
      try { tt = await transform(r.def); } catch { tt = null; }
      if (tt === null) { skip++; continue; }
      const full = spliceFullFile(r.src, r.startOff, r.endOff, tt);
      let h;
      try { h = await hashSnippet(full, r.file, r.name, r.occurrence); } catch { h = null; }
      if (h === null) { skip++; continue; }
      if (h === r.hash) ok++;
      else {
        bad++;
        if (classify && classify(r.def)) badArtifact++;
        else if (ex.length < 5) ex.push(basename(r.file) + ":" + r.name);
      }
    }
    return { name, ok, bad, badArtifact, badReal: bad - badArtifact, skip, examples: ex };
  }
  out.sameMeaning = [
    await runSame("reformat-whitespace", reformat, hasMultiSpaceInString),
    // AST-aware body comment probe (lands inside the real body, not in an
    // object-type return annotation), spliced back + re-hashed in context.
    await runSame("insert-comments", (t) => insertBodyComment(t, "cpp"), null),
    await runSame("rename-locals", renameLocals, null),
  ];

  // ── (c) body mutations ────────────────────────────────────────────────────
  async function runMut(name, transform) {
    let detected = 0, missed = 0, skip = 0;
    const ex = [];
    for (const r of recs) {
      let tt;
      try { tt = transform(r.def); } catch { tt = null; }
      if (tt === null || tt === r.def) { skip++; continue; }
      const full = spliceFullFile(r.src, r.startOff, r.endOff, tt);
      let h;
      try { h = await hashSnippet(full, r.file, r.name, r.occurrence); } catch { h = null; }
      if (h === null) { skip++; continue; }
      if (h !== r.hash) detected++;
      else { missed++; if (ex.length < 5) ex.push(basename(r.file) + ":" + r.name); }
    }
    return { name, detected, missed, skip, examples: ex };
  }
  out.mutations = [await runMut("add-statement-in-body", addStatement)];

  // ── (d) collisions ────────────────────────────────────────────────────────
  const byHash = new Map();
  for (const r of recs) {
    if (!byHash.has(r.hash)) byHash.set(r.hash, []);
    byHash.get(r.hash).push(r);
  }
  const distinctBodies = new Set(recs.map((r) => normWs(r.body))).size;
  let collidingPairs = 0;
  const collisionGroups = [];
  for (const [h, group] of byHash) {
    const bodies = [...new Set(group.map((g) => normWs(g.body)))];
    if (bodies.length > 1) {
      collidingPairs += (bodies.length * (bodies.length - 1)) / 2;
      collisionGroups.push({ hash: h, members: group.map((g) => g.name + "@" + basename(g.file)), distinctBodies: bodies.length });
    }
  }
  const totalDistinctPairs = (distinctBodies * (distinctBodies - 1)) / 2;
  out.collisions = {
    hashBuckets: byHash.size,
    distinctBodies,
    collisionGroups: collisionGroups.length,
    collidingDistinctPairs: collidingPairs,
    totalDistinctPairs,
    falseCollisionRate: totalDistinctPairs === 0 ? 0 : collidingPairs / totalDistinctPairs,
    examples: collisionGroups,
  };

  // ── analyze() coverage + domains + spec ─────────────────────────────────
  // Run analyze on each root and aggregate (analyze scans a single tree).
  let aFns = 0, aNodes = 0, aEdges = 0, aSpecClauses = 0, aLinks = 0, aSkipped = 0;
  const mechAgg = new Map();
  let lastCtx = null;
  for (const r of ROOTS) {
    const ctx = await analyze(r, { quiet: true });
    lastCtx = ctx;
    aFns += ctx.functions.length;
    const nodes = await ctx.graph.allNodes();
    aNodes += nodes.length;
    // edges: sum over nodes' outgoing edges.
    let edges = 0;
    for (const n of nodes) edges += (await ctx.graph.edgesFrom(n.id)).length;
    aEdges += edges;
    aSpecClauses += (ctx.specClauses ?? []).length;
    aLinks += (ctx.links ?? []).length;
    aSkipped += (ctx.skipped ?? []).length;
    for (const m of ctx.domains ?? []) {
      const prev = mechAgg.get(m.domain) ?? { implementors: 0, violations: 0 };
      prev.implementors += m.implementors.length;
      prev.violations += m.violations.length;
      mechAgg.set(m.domain, prev);
    }
  }
  out.analyzeAggregate = {
    functions: aFns,
    graphNodes: aNodes,
    graphEdges: aEdges,
    specClauses: aSpecClauses,
    links: aLinks,
    skipped: aSkipped,
    domains: [...mechAgg.entries()].map(([k, v]) => ({ domain: k, ...v })),
  };

  // ── Spec linking against the full repo spec/ (cross-tree) ─────────────────
  // analyze() only sees spec/*.md UNDER its root; the subset roots have none, so
  // link the subset's code files against the repo-level spec dir explicitly.
  try {
    const specFiles = await collect(SPEC_DIR, new Set([".md"]));
    if (specFiles.length > 0) {
      const clauses = await parseSpecFiles(specFiles);
      const codeFiles = recs.map((r) => r.file);
      const uniqueCode = [...new Set(codeFiles)];
      const [ex, st] = await Promise.all([
        findExplicitLinks(clauses, uniqueCode),
        findStructuralLinks(clauses, uniqueCode),
      ]);
      out.specLinking = {
        specFiles: specFiles.length,
        clauses: clauses.length,
        codeFiles: uniqueCode.length,
        explicitLinks: ex.length,
        structuralLinks: st.length,
      };
    } else {
      out.specLinking = { note: "no spec dir at " + SPEC_DIR };
    }
  } catch (err) {
    out.specLinking = { error: String(err) };
  }

  // ── Bundle determinism (assemble twice → identical) ───────────────────────
  if (lastCtx) {
    const b1 = await buildContextBundle(lastCtx, { task: "add a new combat action with knockback" });
    const b2 = await buildContextBundle(lastCtx, { task: "add a new combat action with knockback" });
    out.bundleDeterminism = { identical: JSON.stringify(b1) === JSON.stringify(b2) };

    // ── Verify on a real synthetic diff ─────────────────────────────────────
    const diff = `
      void applyKnockback(float impulse, float dir[3]) {
        float v = impulse;
        for (int i = 0; i < 3; ++i) dir[i] *= v;
      }
    `;
    const verdict = await buildVerdict(lastCtx, diff);
    out.verify = {
      pass: verdict.pass,
      gates: verdict.gates.map((g) => ({ gate: g.gate, pass: g.pass })),
      suggestion: verdict.suggestion,
    };
  }

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
