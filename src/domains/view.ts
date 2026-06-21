/**
 * src/domains/view.ts — Domain-view assembly.
 *
 * Turns the raw domain-detection results into a presentation model for the
 * dedicated "Domain View" panel: per domain it carries the implementor anchors
 * (so the panel can focus the graph on just that domain) and the spec clauses
 * linked to those implementors — which, for a Japanese-spec'd codebase, supply
 * a Japanese description of what the domain is *for* (DESIGN §4.4: the domain
 * is the core intent; spec linkage is how we recover its human meaning).
 *
 * SRP: pure data shaping over (domains × links × specClauses). No graph access,
 * no HTTP, no LLM — the LLM-distilled DomainCard is a separate, optional layer.
 *
 * Anchor granularity (why `anchorToFile` exists): every spec linker (explicit,
 * structural, semantic) anchors a link at FILE level — `link.from` is a source
 * file path. Domain implementors, however, are FUNCTION-level anchors. Joining
 * `implementorSet.has(link.from)` therefore never matches on a real codebase, so
 * every domain description came back null even when the spec was richly linked
 * (observed on KuzuSurvivors: 231 Japanese-headed links, all descriptions empty
 * — task #324). We bridge the two by mapping each implementor function to its
 * file and matching links against the domain's file set as well as its anchors.
 */

import type { Link, SpecClause } from "../types.js";
import type { DetectionResult } from "./detect.js";

/** Max spec clauses surfaced per domain. */
const MAX_SPEC_REFS = 5;
/** Excerpt length for a clause's body text. */
const EXCERPT_LEN = 240;

export interface DomainSpecRef {
  clauseId: string;
  heading: string;
  file: string;
  excerpt: string;
  confidence: number;
  evidence: string;
}

export interface DomainView {
  domain: string;
  implementorCount: number;
  conforms: boolean;
  violationCount: number;
  /** AnchorIds implementing the domain — the focused graph's node set. */
  implementors: string[];
  /** Spec clauses linked to this domain's implementors (highest confidence first). */
  specRefs: DomainSpecRef[];
  /**
   * Japanese description interpolated from the spec: the best-linked clause's
   * heading + excerpt. Null when no spec clause links to this domain.
   */
  description: string | null;
}

/** Collapse whitespace and truncate a clause body to a short excerpt. */
function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_LEN ? flat.slice(0, EXCERPT_LEN) + "…" : flat;
}

/**
 * Build the domain-view model.
 *
 * @param domains      Detection results from analyze().
 * @param links        Code↔spec links from analyze() (explicit + structural).
 * @param specClauses  Parsed spec clauses, looked up by link.to.
 * @param anchorToFile Implementor function anchor → its source file path. Lets a
 *                     file-anchored link reach a domain via any implementor that
 *                     lives in that file. Omit (legacy/test) for anchor-only
 *                     matching.
 * @returns One DomainView per domain that has at least one implementor,
 *          sorted by implementor count (descending).
 */
export function buildDomainView(
  domains: DetectionResult[],
  links: Link[],
  specClauses: SpecClause[],
  anchorToFile?: ReadonlyMap<string, string>,
): DomainView[] {
  const clauseById = new Map(specClauses.map((c) => [c.id, c]));

  const views: DomainView[] = [];
  for (const d of domains) {
    if (d.implementors.length === 0) continue;
    const implementorSet = new Set<string>(d.implementors);
    // The files those implementors live in — spec links are file-anchored, so a
    // link reaches the domain when its `from` is the domain's anchor OR one of
    // these files. Empty when no map is supplied (anchor-only legacy behaviour).
    const fileSet = new Set<string>();
    if (anchorToFile) {
      for (const a of d.implementors) {
        const f = anchorToFile.get(a);
        if (f) fileSet.add(f);
      }
    }

    // Highest-confidence link per clause among this domain's implementors/files.
    const bestByClause = new Map<string, Link>();
    for (const link of links) {
      if (!implementorSet.has(link.from) && !fileSet.has(link.from)) continue;
      const prev = bestByClause.get(link.to);
      if (!prev || link.confidence > prev.confidence) bestByClause.set(link.to, link);
    }

    const specRefs: DomainSpecRef[] = [];
    for (const [clauseId, link] of bestByClause) {
      const clause = clauseById.get(clauseId);
      if (!clause) continue;
      specRefs.push({
        clauseId,
        heading: clause.heading,
        file: clause.sourceFile,
        excerpt: excerptOf(clause.text),
        confidence: link.confidence,
        evidence: link.evidence,
      });
    }
    specRefs.sort((a, b) => b.confidence - a.confidence);
    const topRefs = specRefs.slice(0, MAX_SPEC_REFS);

    const description =
      topRefs.length > 0
        ? topRefs[0]!.excerpt
          ? `${topRefs[0]!.heading}: ${topRefs[0]!.excerpt}`
          : topRefs[0]!.heading
        : null;

    views.push({
      domain: d.domain,
      implementorCount: d.implementors.length,
      conforms: d.conforms,
      violationCount: d.violations.length,
      implementors: [...d.implementors],
      specRefs: topRefs,
      description,
    });
  }

  views.sort((a, b) => b.implementorCount - a.implementorCount);
  return views;
}
