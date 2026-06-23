/**
 * src/web-cache/module-access.ts — Module → module access edges.
 *
 * "Where does a module access?" — aggregate the code graph's edges to the module
 * level: for every edge whose endpoints fall in DIFFERENT modules, bump a bucket
 * (source module → target module, by edge kind). This is the precomputed
 * "アクセス先" the scene/domain/module view shows per module.
 *
 * SRP: graph edges × node→module mapping → per-module outgoing access list.
 * No HTTP, no taxonomy I/O (the mapping is injected).
 */

import type { AnchorId, EdgeKind } from "../types.js";
import type { CodeGraphQuery } from "../graph/query.js";
import type { ModuleAccess } from "./types.js";

/** Metadata lookups used to decorate a target module. */
export interface ModuleMeta {
  /** Display label for a module id. */
  labelOf: (moduleId: string) => string;
  /** Domains a module participates in (best-effort). */
  domainsOf: (moduleId: string) => string[];
}

/**
 * Aggregate outgoing accesses per module. `moduleOf` maps a function anchor to
 * its owning module id (undefined → the function is in no tracked module and its
 * edges are skipped).
 */
export async function computeModuleAccesses(
  graph: CodeGraphQuery,
  moduleOf: (anchor: AnchorId) => string | undefined,
  meta: ModuleMeta,
): Promise<Map<string, ModuleAccess[]>> {
  // src module → tgt module → { count, kinds }
  const acc = new Map<string, Map<string, { count: number; kinds: Map<EdgeKind, number> }>>();

  const nodes = await graph.allNodes();
  for (const node of nodes) {
    const src = moduleOf(node.id);
    if (src === undefined) continue;
    const edges = await graph.edgesFrom(node.id);
    for (const e of edges) {
      const tgt = moduleOf(e.to);
      if (tgt === undefined || tgt === src) continue;
      let byTarget = acc.get(src);
      if (!byTarget) acc.set(src, (byTarget = new Map()));
      let bucket = byTarget.get(tgt);
      if (!bucket) byTarget.set(tgt, (bucket = { count: 0, kinds: new Map() }));
      bucket.count++;
      bucket.kinds.set(e.kind, (bucket.kinds.get(e.kind) ?? 0) + 1);
    }
  }

  const out = new Map<string, ModuleAccess[]>();
  for (const [src, byTarget] of acc) {
    const list: ModuleAccess[] = [...byTarget.entries()]
      .map(([targetModuleId, b]) => ({
        targetModuleId,
        targetLabel: meta.labelOf(targetModuleId),
        targetDomains: meta.domainsOf(targetModuleId),
        count: b.count,
        kinds: Object.fromEntries(b.kinds) as Partial<Record<EdgeKind, number>>,
      }))
      .sort((a, b) => b.count - a.count || (a.targetModuleId < b.targetModuleId ? -1 : 1));
    out.set(src, list);
  }
  return out;
}
