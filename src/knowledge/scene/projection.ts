import { createHash } from "node:crypto";
import { canonicalJson } from "../canonical-json.js";
import type { GeneratedArtifact } from "../types.js";
import type { CanonicalScene, CanonicalSceneGraph, SceneManifest } from "./types.js";

function fileName(sceneId: string): string {
  const readable = sceneId.split("/").at(-1)?.replace(/[^A-Za-z0-9._~-]+/g, "-") || "scene";
  const digest = createHash("sha256").update(sceneId, "utf8").digest("hex").slice(0, 10);
  return `${readable}-${digest}.md`;
}

function yaml(value: string): string {
  return JSON.stringify(value.normalize("NFC"));
}

function list(values: string[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ["- (none)"];
}

export function renderSceneOkf(scene: CanonicalScene, graph: CanonicalSceneGraph): string {
  const direct = new Set(scene.entryCodeSymbolIds);
  const reached = scene.reachedCodeSymbolIds.filter((id) => !direct.has(id));
  return [
    "---",
    "type: data",
    `title: ${yaml(scene.label)}`,
    `service: ${yaml(graph.projectId)}`,
    "status: implemented",
    "x-anatomia:",
    "  kind: scene",
    `  id: ${yaml(scene.id)}`,
    "  generated: true",
    `  source-revision: ${yaml(graph.sourceRevision)}`,
    `  source-fingerprint: ${yaml(graph.definitionFingerprint)}`,
    "  generator-schema: 1",
    "---",
    "",
    `# ${scene.label}`,
    "",
    `Definition origin: ${scene.origin}; identity: ${scene.identityBasis}.`,
    `Source: ${scene.sourceAnchor.path}:${scene.sourceAnchor.startLine} (${scene.sourceAnchor.reason})`,
    "",
    "## Entry CodeSymbols",
    "",
    ...list(scene.entryCodeSymbolIds),
    "",
    "## Reached CodeSymbols (non-entry)",
    "",
    ...list(reached),
    "",
    "## Elements",
    "",
    ...list(scene.elements.map((element) => `${element.id} -> ${element.realizedByCodeSymbolIds.join(", ") || "(none)"}`)),
    "",
    "## Transitions",
    "",
    ...list(scene.transitionSceneIds),
    "",
    "## Active Domains",
    "",
    ...list(scene.activeDomainIds),
    "",
    "## Related SpecClauses",
    "",
    ...list(scene.relatedSpecClauseIds),
    "",
    "Complete relations: `../scene-edges.jsonl`.",
    "",
  ].join("\n");
}

export function buildSceneProjection(
  graph: CanonicalSceneGraph,
  knowledgeHead: string,
): { manifest: SceneManifest; artifacts: GeneratedArtifact[] } {
  const manifest: SceneManifest = {
    schemaVersion: 1,
    projectionSchema: 1,
    projectId: graph.projectId,
    knowledgeHead,
    sourceRevision: graph.sourceRevision,
    definitionFingerprint: graph.definitionFingerprint,
    scenes: graph.scenes,
  };
  const edgeJsonl = graph.edges.map((edge) => canonicalJson(edge)).join("\n") + (graph.edges.length > 0 ? "\n" : "");
  const artifacts: GeneratedArtifact[] = [
    { path: "scene-manifest.json", content: canonicalJson(manifest) + "\n", entityId: `scene-manifest:${graph.projectId}` },
    { path: "scene-edges.jsonl", content: edgeJsonl, entityId: `scene-edges:${graph.projectId}` },
    ...graph.scenes.map((scene) => ({
      path: `scenes/${fileName(scene.id)}`,
      content: renderSceneOkf(scene, graph),
      entityId: scene.id,
    })),
  ];
  return { manifest, artifacts };
}
