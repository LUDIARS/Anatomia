import { relative } from "node:path";
import type { AnalysisContext } from "../../core.js";
import type { ScreenGraph, ScreenNode } from "../../screens/index.js";
import { sceneEntityId } from "../identity.js";
import type { SceneDefinitionOrigin, SceneDefinitionSeed, SceneManifest } from "./types.js";

export interface SceneIdentityInput {
  projectId: string;
  nativeId?: string | null;
  explicitId?: string | null;
  routeId?: string | null;
  qualifiedEntry?: string | null;
  sourceIdentity: string;
}

export function resolveSceneIdentity(input: SceneIdentityInput): Pick<SceneDefinitionSeed, "sceneId" | "nativeIdentity" | "identityBasis"> {
  const candidates: Array<[SceneDefinitionSeed["identityBasis"], string | null | undefined]> = [
    ["native-id", input.nativeId],
    ["explicit-id", input.explicitId],
    ["route-id", input.routeId],
    ["qualified-entry", input.qualifiedEntry],
    ["source-fallback", input.sourceIdentity],
  ];
  const [identityBasis, nativeIdentity] = candidates.find(([, value]) => Boolean(value?.trim()))!;
  return {
    sceneId: sceneEntityId(input.projectId, `${identityBasis}:${nativeIdentity!.trim()}`),
    nativeIdentity: nativeIdentity!.trim(),
    identityBasis,
  };
}

function originOf(screen: ScreenNode): SceneDefinitionOrigin {
  if (screen.stack === "unity" && screen.kind === "scene") return "engine-asset";
  if (screen.route) return "route";
  return "static-code";
}

async function entryNodes(ctx: AnalysisContext, screen: ScreenNode) {
  if (!screen.file) return [];
  return (await ctx.graph.allNodes())
    .filter((node) => relative(ctx.repoPath, node.sourceRange.filePath).replace(/\\/g, "/") === screen.file)
    .filter((node) => node.id !== null)
    .sort((left, right) => left.sourceRange.start.line - right.sourceRange.start.line
      || left.name.localeCompare(right.name));
}

/**
 * Routes shared by more than one screen (same-named components in different
 * files bound to one routing entry) cannot serve as a scene identity on their
 * own: two definitions would collapse into one canonical ID and the sync
 * would fail with "duplicate canonical scene identity". Qualify the route with
 * the declaring file for those screens only, so unique routes keep their
 * file-independent identity and ambiguous ones stay distinct and deterministic.
 */
function ambiguousRoutes(graph: ScreenGraph): Set<string> {
  const counts = new Map<string, number>();
  for (const screen of graph.screens) {
    if (!screen.route) continue;
    counts.set(screen.route, (counts.get(screen.route) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([route]) => route));
}

function routeIdentity(screen: ScreenNode, ambiguous: ReadonlySet<string>): string | null {
  if (!screen.route) return null;
  if (!ambiguous.has(screen.route)) return screen.route;
  return screen.file ? `${screen.route}@${screen.file}` : null;
}

/** Bare child names replaced by their import-qualified form when detect.ts resolved one. */
function containsReferences(screen: ScreenNode): string[] {
  const qualified = new Map<string, string>();
  for (const ref of screen.containsQualified ?? []) {
    const name = ref.slice(ref.lastIndexOf("#") + 1);
    if (!qualified.has(name)) qualified.set(name, ref);
  }
  return screen.contains.map((name) => qualified.get(name) ?? name);
}

export async function inventoryScreenScenes(
  projectId: string,
  ctx: AnalysisContext,
  graph: ScreenGraph,
  sourceRevision: string,
): Promise<SceneDefinitionSeed[]> {
  const ambiguous = ambiguousRoutes(graph);
  return Promise.all(graph.screens.map(async (screen) => {
    const entries = await entryNodes(ctx, screen);
    const routeId = routeIdentity(screen, ambiguous);
    const identity = resolveSceneIdentity({
      projectId,
      nativeId: screen.stack === "unity" && screen.kind === "scene" ? screen.route ?? screen.name : null,
      routeId,
      // A symbol name/signature is not qualified without its declaring source.
      // Keeping the path here prevents same-named components in different files
      // from collapsing into one canonical scene.
      qualifiedEntry: screen.file
        ? `${screen.file}#${screen.name}`
        : entries[0]?.signatureShape ?? entries[0]?.name,
      sourceIdentity: `${screen.stack}:${screen.kind}:${screen.file || "<asset>"}`,
    });
    return {
      ...identity,
      label: screen.route ? `${screen.name} (${screen.route})` : screen.name,
      kind: screen.kind,
      origin: originOf(screen),
      sourceRevision,
      sourceAnchor: {
        path: screen.file,
        startLine: screen.line,
        endLine: screen.line,
        detector: `screen:${screen.stack}`,
        reason: screen.reason,
      },
      entryAnchorIds: entries.map((node) => String(node.id)),
      referenceKeys: [...new Set([
        screen.name,
        // A shared route is not a usable reference either: it would make every
        // transition to it an "ambiguous scene reference" error. The qualified
        // route stays referenceable through nativeIdentity below.
        screen.route && !ambiguous.has(screen.route) ? screen.route : null,
        screen.file,
        screen.file ? `${screen.file}#${screen.name}` : null,
        identity.nativeIdentity,
      ].filter((value): value is string => Boolean(value)))].sort(),
      // Prefer import-resolved `<file>#<Name>` references: they select the exact
      // declaring file even when several screens share a display name.
      containsRefs: [...new Set(containsReferences(screen))].sort(),
      transitionRefs: [...new Set(screen.navigatesTo)].sort(),
      aliases: [],
      tombstone: false,
    };
  })).then((definitions) => definitions.sort((left, right) => left.sceneId.localeCompare(right.sceneId)));
}

function activeDefinitionsByReference(
  definitions: SceneDefinitionSeed[],
): Map<string, SceneDefinitionSeed[]> {
  const index = new Map<string, SceneDefinitionSeed[]>();
  for (const definition of definitions) {
    if (definition.tombstone) continue;
    for (const reference of definition.referenceKeys) {
      index.set(reference, [...(index.get(reference) ?? []), definition]);
    }
  }
  return index;
}

/** Keeps removed definitions as tombstones and records superseded IDs as aliases. */
export function reconcileSceneInventory(
  previous: SceneDefinitionSeed[],
  current: SceneDefinitionSeed[],
): SceneDefinitionSeed[] {
  const currentByNative = new Map(current.map((seed) => [`${seed.origin}:${seed.nativeIdentity}`, seed]));
  const currentIds = new Set(current.map((seed) => seed.sceneId));
  const previousByReference = activeDefinitionsByReference(previous);
  const currentByReference = activeDefinitionsByReference(current);
  const reconciled = current.map((seed) => {
    const exact = previous.find((item) => `${item.origin}:${item.nativeIdentity}` === `${seed.origin}:${seed.nativeIdentity}`);
    const stableReference = seed.referenceKeys.find((reference) =>
      currentByReference.get(reference)?.length === 1
      && previousByReference.get(reference)?.length === 1);
    const predecessor = exact ?? (stableReference
      ? previousByReference.get(stableReference)?.[0]
      : undefined);
    return predecessor && predecessor.sceneId !== seed.sceneId
      ? { ...seed, aliases: [...new Set([...seed.aliases, predecessor.sceneId, ...predecessor.aliases])].sort() }
      : seed;
  });
  for (const seed of previous) {
    if (currentIds.has(seed.sceneId) || currentByNative.has(`${seed.origin}:${seed.nativeIdentity}`)) continue;
    reconciled.push({ ...seed, tombstone: true });
  }
  return reconciled.sort((left, right) => left.sceneId.localeCompare(right.sceneId));
}

export function inventoryFromManifest(manifest: SceneManifest): SceneDefinitionSeed[] {
  return manifest.scenes.map((scene) => ({
    sceneId: scene.id,
    nativeIdentity: scene.nativeIdentity,
    identityBasis: scene.identityBasis,
    label: scene.label,
    kind: scene.kind,
    origin: scene.origin,
    sourceRevision: scene.sourceRevision,
    sourceAnchor: scene.sourceAnchor,
    entryAnchorIds: [],
    referenceKeys: scene.referenceKeys,
    containsRefs: scene.containedSceneIds,
    transitionRefs: scene.transitionSceneIds,
    aliases: scene.aliases,
    tombstone: scene.tombstone,
  }));
}
