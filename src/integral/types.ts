/**
 * src/integral/types.ts — Integral-search types (the 3-layer scoped retrieval).
 *
 * "Integral search" is the FIRST pass that compiles the necessity set for a task
 * the user wants to work on (DESIGN: 構造グラフ × ドメイン × シーンステート).
 * Given an entry point and a scope, it walks the containment chain
 *   function → containing domain(s) → containing scene(s) → other domains in
 *   those scenes
 * bounded by an exploration range, and returns a layer-aware bundle. It is
 * deterministic and LLM-free — the effort target is ≤10s (the bundle is then
 * optionally handed to a Sonnet agent that JUDGES how far is enough, see agent.ts).
 *
 * SRP: type definitions only. No logic, no runtime imports.
 *
 * The Agent input format is fixed at three parts (DESIGN, challenge 2):
 *   ① entry  — the initial thing to look at + its scope (function|domain|scene)
 *   ② graph  — the related graph info (seed anchors + known domains/scenes)
 *   ③ range  — the exploration range (hop / node / time bounds)
 */

import type { AnchorId, Rule, SpecClause } from "../types.js";

/** The scope at which the entry point is named. */
export type IntegralScope = "function" | "domain" | "scene";

/** ② Related graph info accompanying the query (all optional hints). */
export interface IntegralGraphHint {
  /** Seed anchors already known to the caller (besides those `entry.ref` resolves to). */
  seedAnchors?: AnchorId[];
  /** Domains the caller already knows are relevant (names). */
  knownDomains?: string[];
  /** Scenes the caller already knows are relevant (ids). */
  knownScenes?: string[];
}

/** ③ Exploration range — the bounds the deterministic walk must honour. */
export interface IntegralRange {
  /** Max graph hops from a seed when gathering the impact radius. Default 2. */
  maxHops?: number;
  /** Hard cap on the number of anchors materialised across all layers. Default 400. */
  maxNodes?: number;
  /**
   * Soft wall-clock budget in ms for the deterministic pass. When exceeded the
   * walk stops early and the result is flagged `truncated` (no silent caps). The
   * effort target for integral search is 10s. Default 10000.
   */
  budgetMs?: number;
  /**
   * How far up the containment chain to climb:
   *   "function"        — seeds + their direct graph radius only;
   *   "module"          — + the whole 機能(module) each seed lives in;
   *   "domain"          — + the domains those seeds/modules belong to;
   *   "scene"           — + the scenes those domains belong to;
   *   "scene-adjacent"  — + the OTHER domains active in those scenes (default).
   * The Sonnet judge can recommend tightening this for the next call.
   */
  climb?: "function" | "module" | "domain" | "scene" | "scene-adjacent";
}

/** ① + ② + ③ — the full integral query = the fixed Agent input format. */
export interface IntegralQuery {
  /** ① Initial look-at point and its scope. */
  entry: { ref: string; scope: IntegralScope };
  /** ② Related graph info. */
  graph?: IntegralGraphHint;
  /** ③ Exploration range. */
  range?: IntegralRange;
}

/** A function surfaced by the search, with just enough to locate + judge it. */
export interface IntegralAnchor {
  id: AnchorId;
  name: string;
  file: string;
  line: number;
  /** Which layer pulled this anchor in (seed | radius | module | domain | scene). */
  via: "seed" | "radius" | "module" | "domain" | "scene";
}

/** A 機能(module) surfaced by the search, with its cohesion when known. */
export interface IntegralModule {
  id: string;
  label: string;
  /** Materialised member anchors (within the search's set). */
  anchors: AnchorId[];
  /** Cohesion 0..1 from the analyze-time module evaluation, or null when not computed. */
  cohesion: number | null;
  /** True when the seed lives in this module (the entry's home module). */
  isHome: boolean;
}

/** A domain surfaced by the search. */
export interface IntegralDomain {
  name: string;
  /** How the search reached it: the seed is in it, or it is scene-adjacent. */
  via: "direct" | "scene-adjacent";
  /** Implementor anchors of this domain that fall within the materialised set. */
  anchors: AnchorId[];
}

/** A scene surfaced by the search. */
export interface IntegralScene {
  id: string;
  label?: string;
  /** Domains active in this scene. */
  domains: string[];
  /**
   * True when this scene's active-domain set is the singleton {D} of a domain
   * already surfaced directly — i.e. the "scene ≈ domain" coincidence the design
   * notes (シーンとドメインが一致するケース). Surfaced, never force-separated.
   */
  coincidesWithDomain?: string;
}

/**
 * Phase A output: the deterministic necessity set, layer by layer. This is the
 * "初回の必要点まとめ" the design asks integral search to produce.
 */
export interface IntegralResult {
  query: IntegralQuery;
  /** Anchors the seeds resolved to (the user's chosen starting point). */
  seeds: AnchorId[];
  anchors: IntegralAnchor[];
  /** 機能(module) layer between functions and domains. */
  modules: IntegralModule[];
  domains: IntegralDomain[];
  scenes: IntegralScene[];
  /** Spec clauses linked to the materialised anchors/files (human meaning). */
  specClauses: SpecClause[];
  /** Architecture rules in force for the surfaced domains. */
  rules: Rule[];
  /** True when a range bound stopped the walk early. */
  truncated: boolean;
  /** Why the walk stopped (e.g. "maxNodes", "budgetMs", "complete"). */
  stopReason: "complete" | "maxNodes" | "budgetMs";
  /** Wall-clock ms the deterministic pass took. */
  elapsedMs: number;
  /** Content key over (seed anchors + range) — the path-cache key input. */
  contentKey: string;
}

/**
 * Phase B output: the Sonnet agent's judgement of how far the caller actually
 * needs to load. "ブラックボックスで判断できるものは判断して返す" — when the
 * agent can answer self-contained, `sufficientScope` + `answer` carry it.
 */
export interface ScopeDecision {
  /** The narrowest climb level the agent judges sufficient for the task. */
  sufficientScope: IntegralScope | "scene-adjacent";
  /** Anchors the agent judges essential (subset of the result, by id). */
  keepAnchors: AnchorId[];
  /** Domains the agent judges essential. */
  keepDomains: string[];
  /** Why it stopped there (one or two sentences). */
  reason: string;
  /** 0–1 confidence the kept scope is sufficient. */
  confidence: number;
  /**
   * A self-contained answer when the agent can resolve the task from the bundle
   * alone (blackbox case). Null when the caller must load + reason further.
   */
  answer: string | null;
}

/** Phase A + (optional) Phase B, with provenance for the path cache. */
export interface IntegralReport {
  result: IntegralResult;
  decision: ScopeDecision | null;
  /** True when this report was replayed from the path cache (no fresh Sonnet call). */
  cached: boolean;
}
