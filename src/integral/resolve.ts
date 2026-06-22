/**
 * src/integral/resolve.ts — Resolve an integral entry ref → seed anchors.
 *
 * The entry `ref` is deliberately forgiving so a caller (human or agent) can
 * name the thing it wants to work on however it knows it:
 *   scope "function" — an AnchorId, a function name, or a `file:line` / file path
 *   scope "domain"   — a domain name (→ its implementor anchors)
 *   scope "scene"    — a scene id (→ the implementor anchors of its domains)
 * Resolution is deterministic: ambiguous names resolve to ALL matches in a
 * stable (anchor-sorted) order, so the same ref always yields the same seeds.
 *
 * SRP: ref → AnchorId[] only. No traversal (search.ts), no LLM.
 */

import type { AnchorId, CodeNode } from "../types.js";
import type { CodeGraphQuery } from "../graph/query.js";
import type { DetectionResult } from "../domains/detect.js";
import type { IntegralScope } from "./types.js";
import type { SceneModel } from "./scene.js";

export interface ResolveInputs {
  graph: CodeGraphQuery;
  domains: DetectionResult[];
  scenes: SceneModel;
}

/** Normalise a path to forward slashes for matching. */
function fwd(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Stable sort of anchors so resolution is deterministic. */
function sortedUnique(anchors: AnchorId[]): AnchorId[] {
  return [...new Set(anchors)].sort();
}

/**
 * Resolve a function-scope ref to anchors. Tries, in order:
 *   1. exact AnchorId (the node exists);
 *   2. `file:line` — the function whose range contains that line;
 *   3. a file path suffix — every function in that file;
 *   4. an exact function name — every function with that name.
 */
async function resolveFunctionRef(ref: string, graph: CodeGraphQuery): Promise<AnchorId[]> {
  const nodes = await graph.allNodes();

  // 1. exact anchor id.
  const byId = nodes.find((n) => n.id === ref);
  if (byId) return [byId.id];

  // 2. file:line.
  const m = /^(.*):(\d+)$/.exec(ref);
  if (m) {
    const wantFile = fwd(m[1]!);
    const wantLine = Number(m[2]);
    const hits = nodes.filter((n) => {
      const f = fwd(n.sourceRange.filePath);
      return (
        (f === wantFile || f.endsWith("/" + wantFile) || f.endsWith(wantFile)) &&
        n.sourceRange.start.line <= wantLine &&
        n.sourceRange.end.line >= wantLine
      );
    });
    if (hits.length > 0) return sortedUnique(hits.map((n) => n.id));
  }

  // 3. file path suffix (a/b/foo.cpp).
  if (ref.includes("/") || ref.includes("\\") || /\.[a-z]+$/i.test(ref)) {
    const want = fwd(ref);
    const inFile = nodes.filter((n) => {
      const f = fwd(n.sourceRange.filePath);
      return f === want || f.endsWith("/" + want) || f.endsWith(want);
    });
    if (inFile.length > 0) return sortedUnique(inFile.map((n) => n.id));
  }

  // 4. exact function name.
  const byName = nodes.filter((n: CodeNode) => n.name === ref);
  return sortedUnique(byName.map((n) => n.id));
}

/** Resolve a domain-scope ref → that domain's implementor anchors. */
function resolveDomainRef(ref: string, domains: DetectionResult[]): AnchorId[] {
  const d = domains.find((x) => x.domain === ref);
  return d ? sortedUnique(d.implementors) : [];
}

/**
 * Resolve a scene-scope ref → the implementor anchors of every domain active in
 * that scene (a scene is identified by id; its domains map to their anchors).
 */
function resolveSceneRef(
  ref: string,
  scenes: SceneModel,
  domains: DetectionResult[],
): AnchorId[] {
  const scene = scenes.sceneById(ref);
  if (!scene) return [];
  const out: AnchorId[] = [];
  for (const domName of scene.domains) {
    const d = domains.find((x) => x.domain === domName);
    if (d) out.push(...d.implementors);
  }
  return sortedUnique(out);
}

/** Resolve an entry (ref + scope) to a deterministic seed-anchor set. */
export async function resolveSeeds(
  entry: { ref: string; scope: IntegralScope },
  inputs: ResolveInputs,
): Promise<AnchorId[]> {
  switch (entry.scope) {
    case "function":
      return resolveFunctionRef(entry.ref, inputs.graph);
    case "domain":
      return resolveDomainRef(entry.ref, inputs.domains);
    case "scene":
      return resolveSceneRef(entry.ref, inputs.scenes, inputs.domains);
  }
}
