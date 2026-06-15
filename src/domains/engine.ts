/**
 * T14 — Rule predicate engine.
 *
 * Evaluates a concrete Predicate (types.ts ADT) against a CodeGraphQuery and
 * returns the list of Violations. SRP: this file ONLY interprets the predicate
 * ADT into graph queries; NodeFilter matching is delegated to predicate.ts.
 *
 * TemplatePredicate is resolved through an injected resolver so the engine
 * stays decoupled from the template module (T16), avoiding a circular import.
 *
 * Boolean semantics (a Predicate is a constraint; a Violation = broken):
 *   And  union of all child violations (every constraint must hold).
 *   Or   violated only if EVERY child is violated (satisfied if one holds).
 *   Not  violation when the inner constraint is NOT violated.
 */

import type {
  AnchorId,
  CodeNode,
  Edge,
  Predicate,
  Violation,
} from "../types.js";
import type { CodeGraphQuery } from "../graph/query.js";
import { matchesFilter, selectNodes } from "./predicate.js";

/**
 * Resolver for TemplatePredicate. Injected so the engine does not depend on the
 * template module. Returns the violations a template produced.
 */
export type TemplateResolver = (
  templateId: string,
  graph: CodeGraphQuery,
  ruleId: string,
) => Promise<Violation[]>;

export interface EvaluateOptions {
  /** Rule id stamped onto produced violations. Defaults to "<anonymous>". */
  ruleId?: string;
  /** Violation severity. Defaults to "error". */
  severity?: Violation["severity"];
  /** Resolver for TemplatePredicate kinds. */
  templateResolver?: TemplateResolver;
}

/** Evaluate a predicate against the graph and return all violations. */
export async function evaluatePredicate(
  pred: Predicate,
  graph: CodeGraphQuery,
  options: EvaluateOptions = {},
): Promise<Violation[]> {
  const ruleId = options.ruleId ?? "<anonymous>";
  const severity = options.severity ?? "error";
  const ctx: Ctx = { ruleId, severity, graph, options };
  return evalNode(pred, ctx);
}

interface Ctx {
  ruleId: string;
  severity: Violation["severity"];
  graph: CodeGraphQuery;
  options: EvaluateOptions;
}

async function evalNode(pred: Predicate, ctx: Ctx): Promise<Violation[]> {
  switch (pred.type) {
    case "EdgeForbidden":
      return evalEdgeForbidden(pred, ctx);
    case "FanInCap":
      return evalFanCap(pred, ctx, "in");
    case "FanOutCap":
      return evalFanCap(pred, ctx, "out");
    case "NoCycle":
      return evalNoCycle(pred, ctx);
    case "TemplatePredicate":
      return evalTemplate(pred, ctx);
    case "And":
      return evalAnd(pred, ctx);
    case "Or":
      return evalOr(pred, ctx);
    case "Not":
      return evalNot(pred, ctx);
    default: {
      const _never: never = pred;
      return _never;
    }
  }
}

async function evalEdgeForbidden(
  pred: Extract<Predicate, { type: "EdgeForbidden" }>,
  ctx: Ctx,
): Promise<Violation[]> {
  const nodes = await ctx.graph.allNodes();
  const byId = new Map<AnchorId, CodeNode>(nodes.map((n) => [n.id, n]));
  const froms = selectNodes(nodes, pred.from);

  const out: Violation[] = [];
  for (const from of froms) {
    const edges = await ctx.graph.edgesFrom(from.id, pred.kind);
    for (const e of edges) {
      const to = byId.get(e.to);
      if (to && matchesFilter(to, pred.to)) {
        out.push({
          ruleId: ctx.ruleId,
          anchors: [from.id, to.id],
          evidence: `forbidden ${pred.kind} edge: ${from.name} -> ${to.name}`,
          severity: ctx.severity,
        });
      }
    }
  }
  return out;
}

async function evalFanCap(
  pred:
    | Extract<Predicate, { type: "FanInCap" }>
    | Extract<Predicate, { type: "FanOutCap" }>,
  ctx: Ctx,
  dir: "in" | "out",
): Promise<Violation[]> {
  const nodes = await ctx.graph.allNodes();
  const targets = selectNodes(nodes, pred.target);
  const out: Violation[] = [];
  for (const t of targets) {
    const counts = await ctx.graph.fanCounts(t.id, pred.kind);
    const actual = dir === "in" ? counts.fanIn : counts.fanOut;
    if (actual > pred.max) {
      out.push({
        ruleId: ctx.ruleId,
        anchors: [t.id],
        evidence: `${t.name} fan-${dir}=${actual} exceeds cap ${pred.max}`,
        severity: ctx.severity,
      });
    }
  }
  return out;
}

async function evalNoCycle(
  pred: Extract<Predicate, { type: "NoCycle" }>,
  ctx: Ctx,
): Promise<Violation[]> {
  const nodes = await ctx.graph.allNodes();
  const scope = selectNodes(nodes, pred.scope);
  const inScope = new Set<AnchorId>(scope.map((n) => n.id));
  const nameOf = new Map<AnchorId, string>(nodes.map((n) => [n.id, n.name]));

  const adj = new Map<AnchorId, AnchorId[]>();
  for (const n of scope) {
    const edges: Edge[] = await ctx.graph.edgesFrom(n.id, pred.kind);
    const outs = edges.map((e) => e.to).filter((to) => inScope.has(to));
    adj.set(n.id, outs);
  }

  const cycles = findCycles(scope.map((n) => n.id), adj);
  const out: Violation[] = [];
  for (const cyc of cycles) {
    out.push({
      ruleId: ctx.ruleId,
      anchors: cyc,
      evidence:
        "cycle among: " + cyc.map((id) => nameOf.get(id) ?? id).join(" -> "),
      severity: ctx.severity,
    });
  }
  return out;
}

/** Find cyclic node groups (SCCs of size>1 plus self-loops) via Tarjan. */
function findCycles(
  ids: AnchorId[],
  adj: Map<AnchorId, AnchorId[]>,
): AnchorId[][] {
  let index = 0;
  const idx = new Map<AnchorId, number>();
  const low = new Map<AnchorId, number>();
  const onStack = new Set<AnchorId>();
  const stack: AnchorId[] = [];
  const sccs: AnchorId[][] = [];

  for (const start of ids) {
    if (idx.has(start)) continue;
    const work: Array<{ v: AnchorId; i: number }> = [{ v: start, i: 0 }];
    idx.set(start, index);
    low.set(start, index);
    index++;
    stack.push(start);
    onStack.add(start);

    while (work.length > 0) {
      const top = work[work.length - 1]!;
      const { v } = top;
      const neighbors = adj.get(v) ?? [];
      if (top.i < neighbors.length) {
        const w = neighbors[top.i]!;
        top.i++;
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, idx.get(w)!));
        }
      } else {
        if (low.get(v) === idx.get(v)) {
          const comp: AnchorId[] = [];
          let w: AnchorId;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
          } while (w !== v);
          const selfLoop = (adj.get(v) ?? []).includes(v);
          if (comp.length > 1 || selfLoop) sccs.push(comp);
        }
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1]!.v;
          low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
        }
      }
    }
  }
  return sccs;
}

async function evalTemplate(
  pred: Extract<Predicate, { type: "TemplatePredicate" }>,
  ctx: Ctx,
): Promise<Violation[]> {
  if (!ctx.options.templateResolver) {
    throw new Error(
      `evaluatePredicate: TemplatePredicate "${pred.templateId}" needs a templateResolver`,
    );
  }
  return ctx.options.templateResolver(pred.templateId, ctx.graph, ctx.ruleId);
}

async function evalAnd(
  pred: Extract<Predicate, { type: "And" }>,
  ctx: Ctx,
): Promise<Violation[]> {
  const out: Violation[] = [];
  for (const child of pred.children) {
    out.push(...(await evalNode(child, ctx)));
  }
  return out;
}

async function evalOr(
  pred: Extract<Predicate, { type: "Or" }>,
  ctx: Ctx,
): Promise<Violation[]> {
  const childResults: Violation[][] = [];
  for (const child of pred.children) {
    const v = await evalNode(child, ctx);
    if (v.length === 0) return [];
    childResults.push(v);
  }
  if (childResults.length === 0) return [];
  const anchors = [...new Set(childResults.flat().flatMap((v) => v.anchors))];
  return [
    {
      ruleId: ctx.ruleId,
      anchors,
      evidence:
        "all Or-branches violated: " +
        childResults
          .map((vs) => vs.map((v) => v.evidence).join("; "))
          .join(" | "),
      severity: ctx.severity,
    },
  ];
}

async function evalNot(
  pred: Extract<Predicate, { type: "Not" }>,
  ctx: Ctx,
): Promise<Violation[]> {
  const inner = await evalNode(pred.child, ctx);
  if (inner.length === 0) {
    return [
      {
        ruleId: ctx.ruleId,
        anchors: [],
        evidence: `Not: inner predicate "${pred.child.type}" held (forbidden)`,
        severity: ctx.severity,
      },
    ];
  }
  return [];
}
