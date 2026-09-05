/**
 * src/knowledge/domain/ux-critical.ts — Which core domains sit directly under
 * the UX (design §7.2 A-10).
 *
 * "The human's main job is DOMAIN REVIEW; domains that touch UX get stronger
 * review and stronger tests." That needs a mark on the domain, and the mark has
 * two sources:
 *
 *   - DECLARED — `uxCritical: true` in the domain's own definition. A human said
 *     so, so it wins.
 *   - DERIVED — the domain owns (approved `domain-owns-code`) a code symbol that
 *     is a screen's DIRECT entry, or lives in a screen's declaring file.
 *
 * A scene's `activeDomainIds` is deliberately NOT a source: it is transitive
 * reachability, so it would mark every domain any screen can eventually reach —
 * which is most of the repository, and a mark everything carries marks nothing.
 *
 * When the two sources disagree the declaration wins AND the disagreement is
 * reported: a domain a human unmarked while screens still enter it is exactly
 * the thing a reviewer should see, not something to resolve silently.
 *
 * SRP: derivation and reconciliation. Presenting the result is the view/plan/
 * review layers.
 *
 * @spec UX 直結ドメイン（`uxCritical`、A-10）
 */

import type { KnowledgeGraph } from "../types.js";

/** Recover the analysis anchor retained on an approved code-symbol node. */
function anchorIdOf(state: KnowledgeGraph, codeSymbolId: string): string | null {
  const fingerprint = state.nodes.get(codeSymbolId)?.revision.contentFingerprint;
  return fingerprint?.startsWith("anchor:") ? fingerprint.slice("anchor:".length) : null;
}

/** The screen-side facts the derivation reads. */
export interface UxCriticalSurface {
  /** Code symbols a screen enters DIRECTLY (not transitively reached). */
  entryCodeSymbolIds: readonly string[];
  /** Repo-relative, forward-slashed declaring files of detected screens. */
  screenFiles: readonly string[];
}

/** What the derivation concluded for one domain. */
export interface UxCriticalFinding {
  domainId: string;
  /** The effective answer: the declaration when there is one, else the derivation. */
  uxCritical: boolean;
  /** `true`/`false` when the definition states it, `null` when it is silent. */
  declared: boolean | null;
  /** Whether screen evidence was found. */
  derived: boolean;
  /** Code symbols the derivation used, sorted; empty when `derived` is false. */
  evidence: string[];
  /** True when a declaration contradicts the screen evidence. */
  conflict: boolean;
}

/** Read `uxCritical` off a domain node's stored definition. */
function declaredFlag(data: Record<string, unknown> | undefined): boolean | null {
  const value = data?.["uxCritical"];
  return typeof value === "boolean" ? value : null;
}

/**
 * Decide `uxCritical` for every domain in the knowledge log.
 *
 * `sourcePathOf` maps a code-symbol id to its repo-relative source path; it is
 * injected because the knowledge log stores the symbol's path on the node in
 * some projections and not in others, and this file must not guess.
 */
export function deriveUxCriticalDomains(
  state: KnowledgeGraph,
  surface: UxCriticalSurface,
  sourcePathOf: (codeSymbolId: string) => string | null = (id) =>
    typeof state.nodes.get(id)?.revision.sourcePath === "string"
      ? state.nodes.get(id)!.revision.sourcePath!.replace(/\\/g, "/")
      : null,
): UxCriticalFinding[] {
  const entrySymbols = new Set(surface.entryCodeSymbolIds);
  const screenFiles = new Set(surface.screenFiles.map((file) => file.replace(/\\/g, "/")).filter((file) => file !== ""));
  const evidenceByDomain = new Map<string, Set<string>>();
  for (const edge of state.edges.values()) {
    if (edge.kind !== "domain-owns-code") continue;
    const path = sourcePathOf(edge.to);
    const anchorId = anchorIdOf(state, edge.to);
    const isSurface = entrySymbols.has(edge.to)
      || (anchorId !== null && entrySymbols.has(anchorId))
      || (path !== null && screenFiles.has(path));
    if (!isSurface) continue;
    const set = evidenceByDomain.get(edge.from) ?? new Set<string>();
    set.add(edge.to);
    evidenceByDomain.set(edge.from, set);
  }
  return [...state.nodes.values()]
    .filter((node) => node.kind === "domain")
    .map((node) => {
      const declared = declaredFlag(node.data);
      const evidence = [...(evidenceByDomain.get(node.id) ?? [])].sort();
      const derived = evidence.length > 0;
      return {
        domainId: node.id,
        uxCritical: declared ?? derived,
        declared,
        derived,
        evidence,
        conflict: declared !== null && declared !== derived,
      };
    })
    .sort((left, right) => left.domainId.localeCompare(right.domainId));
}

/** The ids that end up UX-critical, for callers that only need the set. */
export function uxCriticalDomainIds(findings: readonly UxCriticalFinding[]): Set<string> {
  return new Set(findings.filter((finding) => finding.uxCritical).map((finding) => finding.domainId));
}

/**
 * Resolve UX-critical BUSINESS domains to the DETECTION-taxonomy domain names
 * that `focused-testing` / `plan` speak in.
 *
 * The two taxonomies are not the same namespace and a shared name is not proof
 * of a shared identity, so the bridge goes through approved `domain-owns-code`:
 * a detection domain qualifies when it claims a code symbol the business domain
 * owns. `implementorsOf` supplies the detection side (anchor ids per domain
 * name), which is exactly `AnalysisContext.domains`.
 */
export function resolveUxCriticalDetectionDomains(
  state: KnowledgeGraph,
  uxCriticalIds: ReadonlySet<string>,
  implementorsOf: readonly { domain: string; implementors: readonly string[] }[],
): string[] {
  const ownedSymbols = new Set<string>();
  for (const edge of state.edges.values()) {
    if (edge.kind !== "domain-owns-code" || !uxCriticalIds.has(edge.from)) continue;
    ownedSymbols.add(edge.to);
    const anchorId = anchorIdOf(state, edge.to);
    if (anchorId !== null) ownedSymbols.add(anchorId);
  }
  if (ownedSymbols.size === 0) return [];
  return implementorsOf
    .filter((detection) => detection.implementors.some((anchor) => ownedSymbols.has(anchor)))
    .map((detection) => detection.domain)
    .sort()
    .filter((name, index, all) => all.indexOf(name) === index);
}
