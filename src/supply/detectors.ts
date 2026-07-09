import { relative } from "node:path";
import type { AnalysisContext } from "../core.js";
import type { AnchorId, FunctionNode } from "../types.js";
import type { DomainDetector, LayerRules, SiblingLookup } from "./landing.js";
import { tokenizeRelevanceText } from "./relevance.js";

const DOMAIN_THRESHOLD = 0.15;

export function contextDomainDetector(ctx: AnalysisContext): DomainDetector {
  const byAnchor = functionMap(ctx.functions);
  return async (task) => {
    const taskTokens = new Set(tokenizeRelevanceText(task.description));
    if (taskTokens.size === 0) return [];

    return (ctx.domains ?? [])
      .filter((domain) => domain.implementors.length > 0)
      .map((domain, index) => {
        const texts = [domain.domain];
        for (const anchor of domain.implementors) {
          const fn = byAnchor.get(anchor);
          if (fn) texts.push(fn.name, fn.signature);
        }
        return {
          name: domain.domain,
          index,
          score: overlapScore(taskTokens, tokenizeRelevanceText(texts.join(" "))),
        };
      })
      .filter((x) => x.score >= DOMAIN_THRESHOLD)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.index - b.index)
      .map((x) => x.name);
  };
}

export function contextSiblingLookup(ctx: AnalysisContext): SiblingLookup {
  const byAnchor = functionMap(ctx.functions);
  const layers = domainLayerMap(ctx);
  return async (domain, layer) => {
    const detected = (ctx.domains ?? []).find((d) => d.domain === domain);
    if (!detected) return [];
    return detected.implementors
      .map((anchor) => byAnchor.get(anchor))
      .filter((fn): fn is FunctionNode => fn !== undefined && fn.id !== null)
      .map((fn) => ({
        anchor: fn.id as AnchorId,
        name: fn.name,
        layer: layer ?? layers.get(domain) ?? null,
      }))
      .sort((a, b) => a.anchor.localeCompare(b.anchor) || a.name.localeCompare(b.name));
  };
}

export function contextLayerRules(ctx: AnalysisContext): LayerRules {
  const layers = domainLayerMap(ctx);
  return {
    layerFor(domain: string): string | null {
      return layers.get(domain) ?? null;
    },
  };
}

export function landingInjections(ctx: AnalysisContext): {
  detector: DomainDetector;
  layerRules: LayerRules;
  siblings: SiblingLookup;
} {
  return {
    detector: contextDomainDetector(ctx),
    layerRules: contextLayerRules(ctx),
    siblings: contextSiblingLookup(ctx),
  };
}

function functionMap(functions: FunctionNode[]): Map<AnchorId, FunctionNode> {
  const out = new Map<AnchorId, FunctionNode>();
  for (const fn of functions) {
    if (fn.id) out.set(fn.id, fn);
  }
  return out;
}

function domainLayerMap(ctx: AnalysisContext): Map<string, string> {
  const byAnchor = functionMap(ctx.functions);
  const out = new Map<string, string>();
  for (const domain of ctx.domains ?? []) {
    const counts = new Map<string, number>();
    for (const anchor of domain.implementors) {
      const fn = byAnchor.get(anchor);
      if (!fn) continue;
      const layer = layerFromPath(ctx.repoPath, fn.sourceRange.filePath);
      if (!layer) continue;
      counts.set(layer, (counts.get(layer) ?? 0) + 1);
    }
    const best = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (best) out.set(domain.domain, best[0]);
  }
  return out;
}

function layerFromPath(repoPath: string, filePath: string): string | null {
  const rel = relative(repoPath, filePath).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) return null;
  const first = rel.split("/").find(Boolean);
  return first && first.includes(".") ? null : first ?? null;
}

function overlapScore(taskTokens: Set<string>, candidateTokens: string[]): number {
  const candidate = new Set(candidateTokens);
  let matches = 0;
  for (const token of taskTokens) {
    if (candidate.has(token)) matches++;
  }
  return matches / taskTokens.size;
}
