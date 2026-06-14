/**
 * T17 — Rule mining (reverse rule generation).
 *
 * Given a good exemplar function, propose CandidateRules (predicate +
 * confidence + rationale) that the exemplar satisfies, so they can be ratified
 * into the rule set (DESIGN §4.3 "逆生成" / §4.5 hardening loop).
 *
 * SRP: this file ONLY derives candidate predicates from one exemplar against
 * the graph's distribution; it does not evaluate or persist them.
 *
 * Heuristics implemented:
 *   1. Fan-in cap: if the exemplar's fan-in K is at or below the graph average,
 *      propose FanInCap(max=K). Confidence grows with how far below average.
 *   2. Narrow call set: if the exemplar only calls a small same-named family,
 *      propose forbiddenCall against everything else (approximated by proposing
 *      a layer/forbidden rule from the exemplar to non-called nodes). Here we
 *      emit a forbiddenCall from the exemplar's name to a "broad" callee set it
 *      never touches, when its out-degree is low.
 *   3. Hot-path no-alloc: if the exemplar is tagged hot and has no outgoing
 *      edge to an alloc-tagged node, propose hotPathNoAlloc.
 */

import type { CodeNode, FunctionNode, Predicate } from "../types.js";
import type { CodeGraphQuery } from "../graph/query.js";
import { hotPathNoAlloc } from "./presets.js";

export interface CandidateRule {
  predicate: Predicate;
  /** 0.0–1.0 confidence the rule is a genuine norm. */
  confidence: number;
  rationale: string;
}

export interface MiningOptions {
  /** Tag that marks "hot path" nodes. Default "hotPath". */
  hotPathTag?: string;
  /** Tag that marks "alloc" nodes. Default "alloc". */
  allocTag?: string;
}

/** Compute the average fan-in across all nodes in the graph. */
async function averageFanIn(graph: CodeGraphQuery, nodes: CodeNode[]): Promise<number> {
  if (nodes.length === 0) return 0;
  let total = 0;
  for (const n of nodes) {
    const { fanIn } = await graph.fanCounts(n.id);
    total += fanIn;
  }
  return total / nodes.length;
}

/**
 * Mine candidate rules from an exemplar function.
 */
export async function mineRules(
  exemplar: FunctionNode,
  graph: CodeGraphQuery,
  options: MiningOptions = {},
): Promise<CandidateRule[]> {
  const hotPathTag = options.hotPathTag ?? "hotPath";
  const allocTag = options.allocTag ?? "alloc";
  const candidates: CandidateRule[] = [];

  if (!exemplar.id) return candidates;
  const exId = exemplar.id;

  const allNodes = await graph.allNodes();
  const exNode = await graph.getNode(exId);

  // ── Heuristic 1: fan-in cap ────────────────────────────────────────────────
  const { fanIn } = await graph.fanCounts(exId);
  const avg = await averageFanIn(graph, allNodes);
  if (avg > 0 && fanIn <= avg) {
    // Confidence proportional to how far below average (clamped 0.5..0.95).
    const ratio = 1 - fanIn / avg; // 0 at average, ->1 far below
    const confidence = clamp(0.5 + 0.45 * ratio, 0.5, 0.95);
    candidates.push({
      predicate: {
        type: "FanInCap",
        target: { namePattern: escapeRegex(exemplar.name) },
        max: fanIn,
      },
      confidence,
      rationale: `exemplar "${exemplar.name}" fan-in=${fanIn} <= graph avg ${avg.toFixed(2)}; propose cap at ${fanIn}`,
    });
  }

  // ── Heuristic 2: narrow call set -> forbiddenCall to everything else ────────
  const callees = await graph.neighbors(exId, "calls");
  const calleeNames = new Set(callees.map((c) => c.name));
  const outDegree = callees.length;
  if (outDegree <= 2 && allNodes.length > outDegree + 1) {
    // Propose that this exemplar only calls its current (narrow) callee family;
    // model as forbidding calls to nodes it does NOT currently call.
    const calleePattern = calleeNames.size
      ? `^(?:${[...calleeNames].map(escapeRegex).join("|")})$`
      : "$^"; // matches nothing => "calls nobody"
    const disallowed = `^(?!${calleePattern}).*$`;
    candidates.push({
      predicate: {
        type: "EdgeForbidden",
        from: { namePattern: escapeRegex(exemplar.name) },
        to: { namePattern: disallowed },
        kind: "calls",
      },
      confidence: outDegree === 0 ? 0.6 : 0.55,
      rationale: `exemplar "${exemplar.name}" has narrow out-degree=${outDegree} (calls: ${[...calleeNames].join(", ") || "none"}); propose forbidding calls outside that set`,
    });
  }

  // ── Heuristic 3: hot-path no-alloc ──────────────────────────────────────────
  const isHot = (exNode?.tags ?? []).includes(hotPathTag);
  if (isHot) {
    const callsAlloc = callees.some((c) => (c.tags ?? []).includes(allocTag));
    if (!callsAlloc) {
      candidates.push({
        predicate: hotPathNoAlloc({ hotPathTag, allocTag }),
        confidence: 0.7,
        rationale: `exemplar "${exemplar.name}" is tagged "${hotPathTag}" and calls no "${allocTag}" node; propose hot-path-no-alloc`,
      });
    }
  }

  return candidates;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
