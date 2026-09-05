import { relative } from "node:path";
import type { AnalysisContext } from "../core.js";
import type { AnchorId, FunctionNode } from "../types.js";
import type { DomainDetector, LayerRules, Sibling, SiblingLookup } from "./landing.js";
import { tokenizeRelevanceText } from "./relevance.js";

/**
 * Minimum IDF-weighted share of the task's matchable vocabulary a domain must
 * cover to be returned.
 *
 * The score is a share, not a count, so the floor does not drift with how long
 * a task or a description is. 0.15 was chosen against the real Pictor ontology
 * (24 domains, Japanese descriptions): below it, a task shares nothing but
 * common wording with the domain.
 */
const DOMAIN_THRESHOLD = 0.15;

/**
 * Number of top-scoring domains returned. A task overlaps many descriptions
 * weakly, so the RANKING — not the floor alone — is what keeps the answer
 * usable; `plan` wants a short candidate list, not every domain that shares a
 * bigram.
 */
const MAX_DOMAINS = 5;

/** One scored domain candidate (exported for `plan`'s deterministic fallback). */
export interface DomainScore {
  name: string;
  score: number;
}

/**
 * Score every semantic domain against a free-text task.
 *
 * Candidate text = domain name + DESCRIPTION + the names/signatures of its
 * implementors. The description is what makes a Japanese task ("切り絵のデモを
 * 実装する") matchable at all: implementor identifiers are ASCII, so before it
 * was included every Japanese task scored 0 against every domain and the
 * landing/supply path silently reported "no domain".
 *
 * Tokens are weighted by INVERSE DOCUMENT FREQUENCY over the repo's own
 * domains. Japanese task text is full of terms every description also uses
 * ("実装", "する", "定義"); counting them equally made the top hits the domains
 * with the longest prose rather than the related ones. A token that appears in
 * every domain now carries ~no weight, and one unique to a domain carries the
 * decision.
 */
export function scoreDomains(ctx: AnalysisContext, task: string): DomainScore[] {
  const byAnchor = functionMap(ctx.functions);
  const taskTokens = new Set(tokenizeRelevanceText(task).filter(carriesMeaning));
  if (taskTokens.size === 0) return [];

  // Keep declared-but-empty domains. Landing new work in a domain with no
  // current implementor is valid, and its description can still be the best
  // (or only) match for the task.
  const domains = ctx.domains ?? [];
  const documents = domains.map((domain) => {
    const texts = [domain.domain, domain.description ?? ""];
    for (const anchor of domain.implementors) {
      const fn = byAnchor.get(anchor);
      if (fn) texts.push(fn.name, fn.signature);
    }
    return new Set(tokenizeRelevanceText(texts.join(" ")));
  });

  const weights = idfWeights(taskTokens, documents);
  // Task vocabulary this repo can match at all. A task word no domain uses
  // (a product name, a verb nobody wrote down) says nothing about which domain
  // fits, so it must not dilute the share either.
  let matchable = 0;
  for (const weight of weights.values()) matchable += weight;
  if (matchable === 0) return [];

  return domains
    .map((domain, index) => {
      const document = documents[index]!;
      let matched = 0;
      for (const [token, weight] of weights) {
        if (document.has(token)) matched += weight;
      }
      return { name: domain.domain, index, score: matched / matchable };
    })
    .filter((x) => x.score >= DOMAIN_THRESHOLD)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.index - b.index)
    .slice(0, MAX_DOMAINS)
    .map(({ name, score }) => ({ name, score: Math.round(score * 1000) / 1000 }));
}

/**
 * Japanese verbs that appear in how a TASK is phrased, not in what a domain IS
 * ("切り絵のデモを実装する", "ログ出力を修正する"). They occur in some domain
 * descriptions too, so IDF alone does not suppress them — and a task matching a
 * domain on nothing but 「実装」 produced a confident, wrong landing
 * (Pictor: "切り絵のデモを実装する" → vendored-third-party). They are dropped
 * from the task side only; a domain that really is about 実装 keeps the word in
 * its own text, it just cannot be matched on it alone.
 */
const TASK_STOPWORDS: ReadonlySet<string> = new Set([
  "実装", "対応", "追加", "修正", "変更", "作成", "削除", "更新",
  "実行", "導入", "改善", "調査", "確認", "整理", "検討",
]);

/**
 * True when a token can carry domain meaning.
 *
 * All-hiragana bigrams ("する", "から", "ての") are grammar, present in almost
 * any Japanese sentence; matching on them says nothing about which domain a
 * task belongs to. Kanji/katakana/latin tokens are kept unless they are a
 * task-phrasing verb.
 */
function carriesMeaning(token: string): boolean {
  if (TASK_STOPWORDS.has(token)) return false;
  return !/^[\u3040-\u309f]+$/.test(token);
}

/**
 * IDF weight per task token, over the domain documents. Tokens no document
 * contains are dropped: they are unmatchable, not merely rare.
 */
function idfWeights(
  taskTokens: Set<string>,
  documents: Set<string>[],
): Map<string, number> {
  const weights = new Map<string, number>();
  const total = documents.length;
  for (const token of taskTokens) {
    let frequency = 0;
    for (const document of documents) {
      if (document.has(token)) frequency++;
    }
    if (frequency === 0) continue;
    weights.set(token, Math.log((total + 1) / (frequency + 1)) + 1);
  }
  return weights;
}

export function contextDomainDetector(ctx: AnalysisContext): DomainDetector {
  return async (task) => scoreDomains(ctx, task.description).map((d) => d.name);
}

export function contextSiblingLookup(ctx: AnalysisContext): SiblingLookup {
  const byAnchor = functionMap(ctx.functions);
  const layers = domainLayerMap(ctx);
  return async (domain, layer) => {
    const detected = (ctx.domains ?? []).find((d) => d.domain === domain);
    if (!detected) return [];
    const fns = detected.implementors
      .map((anchor) => byAnchor.get(anchor))
      .filter((fn): fn is FunctionNode => fn !== undefined && fn.id !== null);
    const out: Sibling[] = [];
    for (const fn of fns) {
      const anchor = fn.id as AnchorId;
      const { fanIn: references } = await ctx.graph.fanCounts(anchor);
      out.push({
        anchor,
        name: fn.name,
        // The sibling's OWN layer, from its own file path. Stamping every
        // sibling with the domain's majority layer made them indistinguishable,
        // so the precedent pick could not prefer `src/` over `third_party/`.
        layer: layerFromPath(ctx.repoPath, fn.sourceRange.filePath) ?? layer ?? layers.get(domain) ?? null,
        references,
      });
    }
    return out.sort((a, b) => a.anchor.localeCompare(b.anchor) || a.name.localeCompare(b.name));
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
