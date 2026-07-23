/**
 * src/scenes/from-screens.ts — Project static screen composition into scenes.
 *
 * The screens/ layer detects UI screens and navigation/composition statically.
 * The Scenes view treats those screens as scene seeds, alongside runtime trace
 * phases and manual cross-screen workflow/module scenes.
 *
 * SRP: ScreenGraph -> SceneRef projection only. No filesystem, graph, HTTP, or
 * taxonomy writes.
 */

import type { SceneRef } from "../integral/scene.js";
import type { ScreenGraph, ScreenNode } from "../screens/index.js";

/**
 * Assign a stable, unique scene id to every screen in the graph. Shared by the
 * shallow projection below and the reachability derivation (scenes/derive.ts)
 * so both produce the SAME ids for the same screens — a derived scene can then
 * refine a projected one instead of appearing as a different entity.
 */
export function assignSceneIds(graph: ScreenGraph): Map<ScreenNode, string> {
  const counts = new Map<string, number>();
  for (const screen of graph.screens) {
    counts.set(screen.name, (counts.get(screen.name) ?? 0) + 1);
  }
  const used = new Set<string>();
  const ids = new Map<ScreenNode, string>();
  for (const screen of graph.screens) {
    const id = uniqueSceneId(screen, counts.get(screen.name) ?? 0, used);
    used.add(id);
    ids.set(screen, id);
  }
  return ids;
}

/** Convert a detected screen graph into scene refs. */
export function scenesFromScreenGraph(graph: ScreenGraph): SceneRef[] {
  const ids = assignSceneIds(graph);
  return graph.screens.map((screen) => ({
    id: ids.get(screen)!,
    label: screen.route ? `${screen.name} (${screen.route})` : screen.name,
    domains: [...new Set(screen.domains)].sort(),
  }));
}

function uniqueSceneId(screen: ScreenNode, count: number, used: Set<string>): string {
  if (count <= 1 && !used.has(screen.name)) return screen.name;
  const suffix = screen.file || screen.route || screen.kind;
  const candidate = `${screen.name}@${suffix}`;
  if (!used.has(candidate)) return candidate;
  let i = 2;
  while (used.has(`${candidate}#${i}`)) i += 1;
  return `${candidate}#${i}`;
}
