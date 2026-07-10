/**
 * Deterministic per-domain review (DomainReviewReport).
 *
 * Where build.ts reviews the CODE (violations / hotspots / cycles / …), this
 * file reviews the DOMAIN TAXONOMY itself: how well the detected domains cover
 * and partition the code graph. No LLM, no randomness — every number is a pure
 * function of the AnalysisContext, so the report is cacheable and reproducible.
 *
 * Per-domain findings:
 *   - coverage        : implementors / all functions, plus the unassigned list.
 *   - cohesion/coupling: intra-domain calls edges vs boundary-crossing calls
 *                        edges (conductance-like ratio per domain).
 *   - membership drift: implementors connected (calls, either direction) to NO
 *                        other implementor of the same domain (isolated members).
 *   - overlap         : functions claimed by >= 2 domains (DESIGN §8 domain
 *                        overlap density).
 *   - spec integrity  : domain defs that declare specRefs while none of their
 *                        implementors appears in ctx.links.
 *
 * SRP: pure assembly over AnalysisContext (mirrors build.ts). No I/O, no
 * formatting (domain-review-format.ts), no analysis (core.ts).
 */

import { relative } from "node:path";
import type { AnalysisContext } from "../core.js";
import type { AnchorId, CodeNode } from "../types.js";
import type { DomainDef } from "../domains/ontology.js";
import type { ReviewLocation } from "./build.js";

/** A DomainDef possibly carrying authoring metadata (EditableDomainDef). */
export type DomainDefWithSpecs = DomainDef & { specRefs?: string[] };

export interface DomainReviewEntry {
  domain: string;
  /** Implementor count (functions the detection assigned to this domain). */
  implementors: number;
  /** True iff detection found no error-severity violation for the domain. */
  conforms: boolean;
  /** calls edges with BOTH endpoints inside the domain. */
  internalEdges: number;
  /** calls edges with exactly ONE endpoint inside the domain (boundary). */
  boundaryEdges: number;
  /**
   * internalEdges / (internalEdges + boundaryEdges) — a conductance-like
   * cohesion ratio. null when the domain touches no calls edge at all.
   */
  cohesion: number | null;
  /**
   * Membership drift: implementors with no calls edge (either direction) to any
   * OTHER implementor of the same domain. Empty for domains with < 2
   * implementors (a lone implementor has no peers to connect to). Capped list;
   * `isolatedCount` keeps the true count.
   */
  isolated: ReviewLocation[];
  isolatedCount: number;
}

export interface DomainOverlap {
  anchor: AnchorId;
  name: string;
  file: string;
  line: number;
  /** All domains claiming this function (sorted, >= 2 by construction). */
  domains: string[];
}

export interface SpecIntegrityWarning {
  domain: string;
  /** The specRefs the def declares (evidence for why linkage was expected). */
  specRefs: string[];
  /** Implementor count at detection time (0 is itself a signal). */
  implementors: number;
}

export interface DomainReviewReport {
  project: string;
  /** True counts (listed arrays below may be capped for readability). */
  summary: {
    domains: number;
    /** Function/method nodes in the graph (coverage denominator). */
    functions: number;
    /** Function/method nodes claimed by at least one domain. */
    assigned: number;
    /** assigned / functions (0 when the graph has no functions). */
    coverage: number;
    unassigned: number;
    overlap: number;
    isolated: number;
    specIntegrity: number;
  };
  domains: DomainReviewEntry[];
  /** Function/method nodes in no domain's implementors (capped, sorted). */
  unassigned: ReviewLocation[];
  /** Functions claimed by >= 2 domains (capped, sorted). */
  overlap: DomainOverlap[];
  /** Domains declaring specRefs with zero spec-linked implementors. */
  specIntegrity: SpecIntegrityWarning[];
}

export interface DomainReviewOptions {
  /** Cap on listed unassigned / overlap / isolated entries. Default 50. */
  maxList?: number;
  /**
   * Domain defs providing authoring metadata (specRefs). Detection results in
   * ctx.domains carry no def, so the spec-integrity check needs the defs handed
   * in explicitly (e.g. loadEditableDomains of the project's ontology dir).
   * Omitted / empty → the spec-integrity section is empty.
   */
  domainDefs?: DomainDefWithSpecs[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const sortLocs = (a: ReviewLocation, b: ReviewLocation): number =>
  cmp(a.file, b.file) || a.line - b.line || cmp(a.name, b.name);

/** Node kinds that count as "functions" for coverage purposes. */
const FUNCTION_KINDS = new Set(["function", "method"]);

export async function buildDomainReview(
  ctx: AnalysisContext,
  opts: DomainReviewOptions = {},
): Promise<DomainReviewReport> {
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

  // ── membership: anchor -> sorted set of claiming domains ──────────────────
  const detections = [...(ctx.domains ?? [])].sort((a, b) => cmp(a.domain, b.domain));
  const memberDomains = new Map<AnchorId, Set<string>>();
  for (const d of detections) {
    for (const a of d.implementors) {
      let set = memberDomains.get(a);
      if (!set) {
        set = new Set<string>();
        memberDomains.set(a, set);
      }
      set.add(d.domain);
    }
  }

  // ── coverage: function/method nodes vs assigned ones ──────────────────────
  const functionNodes = nodes.filter((n) => FUNCTION_KINDS.has(n.kind));
  const assignedFns = functionNodes.filter((n) => memberDomains.has(n.id));
  const unassignedAll = functionNodes
    .filter((n) => !memberDomains.has(n.id))
    .map((n) => locOf(n.id))
    .sort(sortLocs);
  const coverage = functionNodes.length === 0 ? 0 : assignedFns.length / functionNodes.length;

  // ── cohesion/coupling + drift connectivity: one pass over all calls edges ──
  const internal = new Map<string, number>();
  const boundary = new Map<string, number>();
  // Implementors seen connected (calls, either direction) to ANOTHER implementor
  // of the same domain — key `${domain}\0${anchor}`.
  const connected = new Set<string>();
  for (const n of nodes) {
    const fromDoms = memberDomains.get(n.id);
    for (const e of await ctx.graph.edgesFrom(n.id, "calls")) {
      const toDoms = memberDomains.get(e.to);
      const union = new Set<string>([...(fromDoms ?? []), ...(toDoms ?? [])]);
      for (const d of union) {
        if (fromDoms?.has(d) && toDoms?.has(d)) {
          internal.set(d, (internal.get(d) ?? 0) + 1);
          // A self-call is not a connection to an *other* implementor.
          if (e.from !== e.to) {
            connected.add(`${d}\0${e.from}`);
            connected.add(`${d}\0${e.to}`);
          }
        } else {
          boundary.set(d, (boundary.get(d) ?? 0) + 1);
        }
      }
    }
  }

  // ── per-domain entries ─────────────────────────────────────────────────────
  const entries: DomainReviewEntry[] = [];
  let isolatedTotal = 0;
  for (const d of detections) {
    const internalEdges = internal.get(d.domain) ?? 0;
    const boundaryEdges = boundary.get(d.domain) ?? 0;
    const denom = internalEdges + boundaryEdges;

    let isolated: ReviewLocation[] = [];
    if (d.implementors.length >= 2) {
      isolated = [...new Set(d.implementors)]
        .filter((a) => !connected.has(`${d.domain}\0${a}`))
        .map(locOf)
        .sort(sortLocs);
    }
    isolatedTotal += isolated.length;

    entries.push({
      domain: d.domain,
      implementors: d.implementors.length,
      conforms: d.conforms,
      internalEdges,
      boundaryEdges,
      cohesion: denom === 0 ? null : internalEdges / denom,
      isolatedCount: isolated.length,
      isolated: isolated.slice(0, maxList),
    });
  }

  // ── overlap: functions claimed by >= 2 domains ─────────────────────────────
  const overlapAll: DomainOverlap[] = [...memberDomains.entries()]
    .filter(([, doms]) => doms.size >= 2)
    .map(([anchor, doms]) => {
      const l = locOf(anchor);
      return { anchor, name: l.name, file: l.file, line: l.line, domains: [...doms].sort(cmp) };
    })
    .sort((a, b) => sortLocs(a as ReviewLocation, b as ReviewLocation));

  // ── spec integrity: specRefs declared but no implementor spec-linked ───────
  // Links are file-granular (Link.from is usually a source path) with occasional
  // function anchors (mirrors build.ts specGaps), so an implementor counts as
  // linked when its anchor OR its source file path appears as a link source.
  const specIntegrity: SpecIntegrityWarning[] = [];
  if (opts.domainDefs && opts.domainDefs.length > 0) {
    const norm = (p: string): string => p.replace(/\\/g, "/");
    const linked = new Set((ctx.links ?? []).map((l) => norm(l.from)));
    const detectionByName = new Map(detections.map((d) => [d.domain, d]));
    const defs = [...opts.domainDefs].sort((a, b) => cmp(a.name, b.name));
    for (const def of defs) {
      const refs = def.specRefs ?? [];
      if (refs.length === 0) continue;
      const det = detectionByName.get(def.name);
      if (!det) continue; // not detected at all — out of this report's scope
      const anyLinked = det.implementors.some((a) => {
        if (linked.has(a)) return true;
        const n: CodeNode | undefined = nodeById.get(a);
        return n !== undefined && linked.has(norm(n.sourceRange.filePath));
      });
      if (!anyLinked) {
        specIntegrity.push({
          domain: def.name,
          specRefs: [...refs].sort(cmp),
          implementors: det.implementors.length,
        });
      }
    }
  }

  return {
    project: ctx.repoPath,
    summary: {
      domains: entries.length,
      functions: functionNodes.length,
      assigned: assignedFns.length,
      coverage,
      unassigned: unassignedAll.length,
      overlap: overlapAll.length,
      isolated: isolatedTotal,
      specIntegrity: specIntegrity.length,
    },
    domains: entries,
    unassigned: unassignedAll.slice(0, maxList),
    overlap: overlapAll.slice(0, maxList),
    specIntegrity,
  };
}
