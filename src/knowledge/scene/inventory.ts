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

export async function inventoryScreenScenes(
  projectId: string,
  ctx: AnalysisContext,
  graph: ScreenGraph,
  sourceRevision: string,
): Promise<SceneDefinitionSeed[]> {
  return Promise.all(graph.screens.map(async (screen) => {
    const entries = await entryNodes(ctx, screen);
    const identity = resolveSceneIdentity({
      projectId,
      nativeId: screen.stack === "unity" && screen.kind === "scene" ? screen.route ?? screen.name : null,
      routeId: screen.route,
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
        screen.route,
        screen.file,
        screen.file ? `${screen.file}#${screen.name}` : null,
        identity.nativeIdentity,
      ].filter((value): value is string => Boolean(value)))].sort(),
      containsRefs: [...new Set(screen.contains)].sort(),
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
