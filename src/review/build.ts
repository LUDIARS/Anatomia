/**
 * Deterministic structural review.
 *
 * Assembles a code review purely from the three artifacts Anatomia already
 * produces — architecture RULES, the DOMAIN graph (detection results) and the
 * AST/code graph — plus spec links when present. No LLM, no embeddings: every
 * finding is a deterministic function of the analyzed context, so the review is
 * cacheable and reproducible (DESIGN: determinism = cache hit = main goal).
 *
 * Findings (each carries source `file:line` so the reviewed code is identifiable
 * without annotating it):
 *   - violations     : rule conformance (layer spine / forbidden call / coupling
 *                      cap / cycle) from RULES × graph.
 *   - hotspots       : high fan-in/out / coupling functions from the AST graph.
 *   - cycles         : cyclic call groups from the AST graph.
 *   - structuralDup  : functions sharing an Anchor ID across locations = exact
 *                      structural clones (Merkle-AST hash collision — free).
 *   - domainCoupling : cross-domain call edges from the DOMAIN graph.
 *   - orphans        : functions with no static caller (fanIn 0).
 *   - specGaps       : functions linked to no spec clause (only when spec exists).
 *
 * SRP: pure assembly over AnalysisContext. No I/O, no formatting (that is the
 * CLI/route's job), no analysis (core.ts).
 */

import { relative } from "node:path";
import type { AnalysisContext } from "../core.js";
import type { AnchorId, ViolationSeverity } from "../types.js";
import { computeMetrics } from "../supply/metrics.js";
import { evaluatePredicate } from "../domains/engine.js";

export interface ReviewLocation {
  anchor: AnchorId;
  name: string;
  /** Repo-relative, forward-slashed source path. */
  file: string;
  line: number;
}

export interface ReviewViolation {
  rule: string;
  severity: ViolationSeverity;
  evidence: string;
  locations: ReviewLocation[];
}

export interface ReviewHotspot extends ReviewLocation {
  fanIn: number;
  fanOut: number;
  coupling: number;
  cyclomatic: number;
}

export interface ReviewDup {
  anchor: AnchorId;
  name: string;
  copies: ReviewLocation[];
}

export interface ReviewDomainCoupling {
  from: string;
  to: string;
  edges: number;
}

export interface ReviewReport {
  project: string;
  /** True counts (the listed arrays below may be capped for readability). */
  summary: {
    violations: number;
    hotspots: number;
    cycles: number;
    structuralDup: number;
    domainCoupling: number;
    orphans: number;
    specGaps: number;
  };
  violations: ReviewViolation[];
  hotspots: ReviewHotspot[];
  cycles: ReviewLocation[][];
  structuralDup: ReviewDup[];
  domainCoupling: ReviewDomainCoupling[];
  orphans: ReviewLocation[];
  /** Source files tied to no spec clause (file-granular). Empty when no spec. */
  specGaps: string[];
}

export interface ReviewOptions {
  /** Top-N functions by coupling to list as hotspots. Default 20. */
  topHotspots?: number;
  /** Cap on listed orphans / specGaps (summary keeps the true count). Default 50. */
  maxList?: number;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export async function buildReview(
  ctx: AnalysisContext,
  opts: ReviewOptions = {},
): Promise<ReviewReport> {
  const topHotspots = opts.topHotspots ?? 20;
  const maxList = opts.maxList ?? 50;

  const nodes = await ctx.graph.allNodes();
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const rel = (p: string): string => {
    try {
      return relative(ctx.repoPath, p).replace(/\\/g, "/");
    } catch {
      return p.replace(/\\/g, "/");
    }
  };
  // Source rows are 0-indexed internally; the review is human-facing, so +1.
  const locOf = (anchor: AnchorId): ReviewLocation => {
    const n = nodeById.get(anchor);
    return {
      anchor,
      name: n?.name ?? String(anchor),
      file: n ? rel(n.sourceRange.filePath) : "",
      line: n ? n.sourceRange.start.line + 1 : 0,
    };
  };
  const sortLocs = (a: ReviewLocation, b: ReviewLocation): number =>
    cmp(a.file, b.file) || a.line - b.line || cmp(a.name, b.name);

  // ── violations (RULES × graph) ─────────────────────────────────────────────
  const violations: ReviewViolation[] = [];
  for (const d of ctx.domains ?? []) {
    for (const v of d.violations) {
      violations.push({
        rule: v.ruleId,
        severity: v.severity,
        evidence: v.evidence,
        locations: v.anchors.map(locOf).sort(sortLocs),
      });
    }
  }
  // Deterministic order + de-dup identical (rule, evidence) pairs.
  const seenViol = new Set<string>();
  const dedupViolations = violations
    .sort((a, b) => cmp(a.rule, b.rule) || cmp(a.evidence, b.evidence))
    .filter((v) => {
      const k = `${v.rule}\0${v.evidence}`;
      if (seenViol.has(k)) return false;
      seenViol.add(k);
      return true;
    });

  // ── hotspots + orphans (AST graph) ─────────────────────────────────────────
  const membershipMap = new Map<string, AnchorId[]>();
  for (const d of ctx.domains ?? []) membershipMap.set(d.domain, d.implementors);
  const metrics = await computeMetrics(ctx.graph, membershipMap);

  const hotspots: ReviewHotspot[] = [...metrics]
    .filter((m) => m.coupling > 0)
    .sort((a, b) => b.coupling - a.coupling || b.cyclomatic - a.cyclomatic || cmp(a.anchor, b.anchor))
    .slice(0, topHotspots)
    .map((m) => ({ ...locOf(m.anchor), fanIn: m.fanIn, fanOut: m.fanOut, coupling: m.coupling, cyclomatic: m.cyclomatic }));

  const orphansAll = metrics
    .filter((m) => m.fanIn === 0)
    .map((m) => locOf(m.anchor))
    .filter((l) => l.name !== "main")
    .sort(sortLocs);

  // ── cycles (AST graph, reusing the NoCycle predicate) ──────────────────────
  const cycleViol = await evaluatePredicate({ type: "NoCycle", scope: {} }, ctx.graph, {
    ruleId: "review/cycle",
    severity: "warning",
  });
  const cycles = cycleViol
    .map((v) => v.anchors.map(locOf).sort(sortLocs))
    .sort((a, b) => (a[0] && b[0] ? sortLocs(a[0], b[0]) : 0));

  // ── structural duplication (path-independent body hash) ────────────────────
  // Group by structuralHash (body+signature, NO file path), so identical
  // functions in different files collide here even though their `id` differs.
  const byStructure = new Map<string, { name: string; loc: ReviewLocation }[]>();
  for (const fn of ctx.functions) {
    if (!fn.id || !fn.structuralHash) continue;
    const loc: ReviewLocation = {
      anchor: fn.id,
      name: fn.name,
      file: rel(fn.sourceRange.filePath),
      line: fn.sourceRange.start.line + 1,
    };
    const arr = byStructure.get(fn.structuralHash);
    if (arr) arr.push({ name: fn.name, loc });
    else byStructure.set(fn.structuralHash, [{ name: fn.name, loc }]);
  }
  const structuralDup: ReviewDup[] = [];
  for (const [structuralHash, entries] of byStructure) {
    // 無名関数 (<anonymous>) は小ラムダが多数重複として出るノイズ。除外する。
    const named = entries.filter((e) => e.name !== "<anonymous>");
    if (named.length === 0) continue;
    // Distinct source locations sharing one structure = exact clones.
    const uniqueLocs = named
      .map((e) => e.loc)
      .filter((l, i, a) => a.findIndex((x) => x.file === l.file && x.line === l.line) === i);
    if (uniqueLocs.length >= 2) {
      structuralDup.push({ anchor: structuralHash as AnchorId, name: named[0]!.name, copies: uniqueLocs.sort(sortLocs) });
    }
  }
  structuralDup.sort((a, b) => b.copies.length - a.copies.length || cmp(a.name, b.name));

  // ── domain coupling (DOMAIN graph) ─────────────────────────────────────────
  // Primary domain per anchor = first domain (sorted) whose implementors hold it.
  const domainOf = new Map<AnchorId, string>();
  const sortedDomains = [...(ctx.domains ?? [])].sort((a, b) => cmp(a.domain, b.domain));
  for (const d of sortedDomains) {
    for (const a of d.implementors) if (!domainOf.has(a)) domainOf.set(a, d.domain);
  }
  const crossCount = new Map<string, number>();
  for (const n of nodes) {
    const fd = domainOf.get(n.id);
    if (!fd) continue;
    for (const e of await ctx.graph.edgesFrom(n.id)) {
      const td = domainOf.get(e.to);
      if (!td || td === fd) continue;
      const k = `${fd} ${td}`;
      crossCount.set(k, (crossCount.get(k) ?? 0) + 1);
    }
  }
  const domainCoupling: ReviewDomainCoupling[] = [...crossCount.entries()]
    .map(([k, edges]) => {
      const [from, to] = k.split(" ");
      return { from: from!, to: to!, edges };
    })
    .sort((a, b) => b.edges - a.edges || cmp(a.from, b.from) || cmp(a.to, b.to));

  // ── spec gaps: files tied to NO spec clause (only when spec exists) ────────
  // Links are file-granular (Link.from is a source path) with occasional
  // function anchors, so a file counts as linked if its path OR any of its
  // functions' ids appears as a link source.
  let specGapsAll: string[] = [];
  if ((ctx.specClauses ?? []).length > 0) {
    const norm = (p: string): string => p.replace(/\\/g, "/");
    const linked = new Set((ctx.links ?? []).map((l) => norm(l.from)));
    specGapsAll = ctx.files
      .filter((f) => {
        if (linked.has(norm(f.path))) return false;
        return !f.functions.some((fn) => fn.id && linked.has(fn.id));
      })
      .map((f) => rel(f.path))
      .sort(cmp);
  }

  return {
    project: ctx.repoPath,
    summary: {
      violations: dedupViolations.length,
      hotspots: hotspots.length,
      cycles: cycles.length,
      structuralDup: structuralDup.length,
      domainCoupling: domainCoupling.length,
      orphans: orphansAll.length,
      specGaps: specGapsAll.length,
    },
    violations: dedupViolations,
    hotspots,
    cycles,
    structuralDup,
    domainCoupling,
    orphans: orphansAll.slice(0, maxList),
    specGaps: specGapsAll.slice(0, maxList),
  };
}
