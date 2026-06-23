/**
 * src/domains/spec-links.ts — Code ↔ spec link rows.
 *
 * Shapes the analyzed links (code anchor → spec clause) into panel rows that
 * carry the resolved function name + clause heading/file. Extracted from the web
 * route so the same rows feed both the live route and the prepared web cache.
 *
 * SRP: links × clauses × node names → rows. No HTTP, no caching.
 */

import type { AnalysisContext } from "../core.js";
import type { LinkEvidence } from "../types.js";

/** One code↔spec link row (panel shape). */
export interface SpecLinkRow {
  from: string;
  fromName: string;
  to: string;
  clauseHeading: string;
  clauseFile: string;
  confidence: number;
  evidence: LinkEvidence;
  ratified: boolean;
}

/** Build the code↔spec link rows for a context. */
export async function buildSpecLinks(ctx: AnalysisContext): Promise<SpecLinkRow[]> {
  const links = ctx.links ?? [];
  const clauseById = new Map((ctx.specClauses ?? []).map((cl) => [cl.id, cl]));
  const nodes = await ctx.graph.allNodes();
  const nameById = new Map(nodes.map((n) => [n.id, n.name]));

  return links.map((link) => {
    const clause = clauseById.get(link.to);
    return {
      from: link.from,
      fromName: nameById.get(link.from) ?? link.from,
      to: link.to,
      clauseHeading: clause?.heading ?? link.to,
      clauseFile: clause?.sourceFile ?? "",
      confidence: link.confidence,
      evidence: link.evidence,
      ratified: link.ratified ?? false,
    };
  });
}
