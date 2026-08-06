import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Project } from "../../project/types.js";
import { canonicalJson } from "../canonical-json.js";
import { domainEntityId } from "../identity.js";
import type { KnowledgeGraph, KnowledgeNode, KnowledgeOperation } from "../types.js";
import type { SceneManifest } from "../scene/types.js";
import { inventoryLegacyKnowledge, legacyInventoryFingerprint } from "./inventory.js";
import type { LegacyAnnotationWrite, LegacyMigrationPlan } from "./types.js";

// @implements SPEC-knowledge-adapter-migration

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function annotationFile(sceneId: string): string {
  return `${createHash("sha256").update(sceneId, "utf8").digest("hex").slice(0, 20)}.md`;
}

function renderAnnotation(projectId: string, sceneId: string, label: string): string {
  return [
    "---", "type: data", `title: ${JSON.stringify(label)}`, `service: ${JSON.stringify(projectId)}`,
    "x-anatomia:", "  kind: scene-annotation", `  scene-id: ${JSON.stringify(sceneId)}`,
    `  label: ${JSON.stringify(label)}`, "---", "", "# Scene display annotation", "",
    "Migrated from the retained legacy manual-scenes artifact.", "",
  ].join("\n");
}

function domainNode(projectId: string, name: string, description: string, sourceFingerprint: string, sources: string[]): KnowledgeNode {
  const id = domainEntityId(projectId, name);
  return {
    id,
    kind: "domain",
    aliases: [name],
    revision: { sourceRevision: sourceFingerprint, contentFingerprint: digest({ name, description, sources }) },
    data: { name, purpose: description, responsibilities: [], boundary: { inScope: [], outOfScope: [] }, assignable: true, migrationSources: sources },
  };
}

async function existingText(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function planLegacyKnowledgeMigration(input: {
  project: Project;
  state: KnowledgeGraph;
  sceneManifest: SceneManifest | null;
  sceneManifestStaleReasons?: string[];
  writeRoot: string;
}): Promise<LegacyMigrationPlan> {
  const legacy = await inventoryLegacyKnowledge(input.project);
  if (legacy.manualScenes.length > 0 && (input.sceneManifestStaleReasons?.length ?? 0) > 0) {
    legacy.conflicts.push({
      code: "stale-scene-manifest",
      path: "data/generated/anatomia/scene-manifest.json",
      detail: `canonical scene manifest is stale: ${input.sceneManifestStaleReasons!.join(", ")}`,
    });
  }
  const sourceFingerprint = legacyInventoryFingerprint(legacy.artifacts);
  const byName = new Map<string, { description: string; sources: string[] }>();
  for (const item of legacy.domains) {
    const previous = byName.get(item.definition.name);
    if (previous && previous.description !== item.definition.description) {
      legacy.conflicts.push({ code: "duplicate-domain", path: item.path, detail: `${item.definition.name} has conflicting descriptions` });
    } else {
      byName.set(item.definition.name, {
        description: item.definition.description,
        sources: [...new Set([...(previous?.sources ?? []), item.path])].sort(),
      });
    }
  }
  const taxonomyPath = legacy.artifacts.find((item) => item.kind === "taxonomy")!.path;
  for (const domain of legacy.taxonomy?.domains ?? []) {
    const previous = byName.get(domain.name);
    if (previous && previous.description !== domain.description) {
      legacy.conflicts.push({ code: "duplicate-domain", path: legacy.artifacts.find((item) => item.kind === "taxonomy")!.path,
        detail: `${domain.name} differs between taxonomy and DomainDef` });
    } else {
      byName.set(domain.name, { description: domain.description, sources: previous?.sources ?? [taxonomyPath] });
    }
  }
  const operations: KnowledgeOperation[] = [];
  const existingDomains = [...input.state.nodes.values()].filter((node) => node.kind === "domain");
  for (const [name, value] of [...byName.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const candidate = domainNode(input.project.id, name, value.description, sourceFingerprint, value.sources);
    const existing = existingDomains.find((node) => node.id === candidate.id || node.data?.name === name);
    if (existing) {
      const existingPurpose = typeof existing.data?.purpose === "string" ? existing.data.purpose : "";
      if (existing.id !== candidate.id || existingPurpose !== value.description) {
        legacy.conflicts.push({ code: "duplicate-domain", path: value.sources.join(", "),
          detail: `${name} conflicts with canonical domain ${existing.id}` });
      }
      continue;
    }
    operations.push({ op: "upsert-node", record: candidate });
  }

  const manifestScenes = input.sceneManifest?.scenes ?? [];
  const annotationWrites: LegacyAnnotationWrite[] = [];
  for (const manual of [...legacy.manualScenes].sort((left, right) => left.id.localeCompare(right.id))) {
    const canonical = manifestScenes.find((scene) => scene.id === manual.id || scene.aliases.includes(manual.id)
      || scene.referenceKeys.includes(manual.id) || scene.label === manual.label);
    if (!canonical) {
      legacy.conflicts.push({ code: "unmatched-manual-scene", path: legacy.artifacts.find((item) => item.kind === "manual-scenes")!.path,
        detail: `${manual.id} cannot be attached to a canonical scene` });
      continue;
    }
    if (annotationWrites.some((write) => write.sceneId === canonical.id)) {
      legacy.conflicts.push({ code: "annotation-collision", path: manual.id, detail: `multiple manual scenes resolve to ${canonical.id}` });
      continue;
    }
    const annotation: LegacyAnnotationWrite = {
      sceneId: canonical.id,
      path: join("data", "scene-annotations", annotationFile(canonical.id)).replace(/\\/g, "/"),
      content: renderAnnotation(input.project.id, canonical.id, manual.label ?? canonical.label),
    };
    const currentAnnotation = await existingText(join(input.writeRoot, annotation.path));
    if (currentAnnotation !== null && currentAnnotation !== annotation.content) {
      legacy.conflicts.push({ code: "annotation-collision", path: annotation.path,
        detail: `existing annotation for ${canonical.id} differs from migration output` });
      continue;
    }
    if (currentAnnotation === null) annotationWrites.push(annotation);
  }
  const warnings = [
    ...(legacy.screens ? [`${legacy.screens.screens.length} legacy screens inventoried; canonical scene sync remains authoritative`] : []),
    ...legacy.manualScenes.filter((scene) => scene.domains.length > 0)
      .map((scene) => `manual scene ${scene.id} domain override is intentionally not migrated`),
  ];
  const transactionIdentity = canonicalJson({ sourceFingerprint, expectedHead: input.state.head });
  const transactionId = `tx:migration/${createHash("sha256").update(transactionIdentity, "utf8").digest("hex").slice(0, 24)}`;
  return {
    schemaVersion: 1,
    projectId: input.project.id,
    expectedHead: input.state.head,
    sourceFingerprint,
    inventory: legacy.artifacts,
    transactionDraft: {
      transactionId,
      analysisSnapshotId: `migration:${sourceFingerprint}`,
      sourceRevisions: { legacy: sourceFingerprint, spec: null, code: null, trace: null },
      origin: "migration",
      operations,
      provenance: { proposalIds: [], approval: { kind: "migration", reviewRef: null }, generatorSchema: 1 },
    },
    annotationWrites,
    conflicts: legacy.conflicts,
    warnings,
    canApply: legacy.conflicts.length === 0,
    originalsRetained: true,
  };
}
