import { createHash } from "node:crypto";
import type { KnowledgeNodeKind } from "./types.js";

const KIND_PREFIX: Record<KnowledgeNodeKind, string> = {
  domain: "domain",
  "spec-document": "spec",
  "spec-clause": "spec-clause",
  "code-symbol": "code",
  "program-domain": "program-domain",
  scene: "scene",
  "scene-element": "scene-element",
};

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._~-]*$/;

function normalizedSegment(value: string, label: string): string {
  const segment = value.trim().toLowerCase();
  if (!SAFE_SEGMENT.test(segment)) {
    throw new Error(`${label} must be a lowercase stable-id segment`);
  }
  return segment;
}

/**
 * Coerce an arbitrary label (repository directory name, `service:` value) into a
 * stable-id segment. Callers that derive a projectId from the filesystem cannot
 * assume it already satisfies SAFE_SEGMENT.
 */
export function normalizeIdSegment(value: string, fallback: string): string {
  const segment = value.normalize("NFKC").toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "");
  return segment || fallback;
}

export function stableEntityId(
  kind: KnowledgeNodeKind,
  projectId: string,
  nativeIdentity: string,
): string {
  const project = normalizedSegment(projectId, "projectId");
  const identity = nativeIdentity
    .split("/")
    .map((segment) => normalizedSegment(segment, "nativeIdentity"))
    .join("/");
  return `${KIND_PREFIX[kind]}:${project}/${identity}`;
}

export function provisionalEntityId(
  kind: KnowledgeNodeKind,
  projectId: string,
  structuralIdentity: string,
): string {
  const digest = createHash("sha256").update(structuralIdentity, "utf8").digest("hex");
  return `${stableEntityId(kind, projectId, `provisional-${digest.slice(0, 24)}`)}?provisional=1`;
}

function durableNativeKey(label: string, value: string): string {
  // SAFE_SEGMENT requires an alphanumeric first character, so the leading strip
  // has to cover "._~" too — "_root" would otherwise reach normalizedSegment as
  // "_root-<digest>" and throw from a function whose job is to coerce anything.
  const readable = value.normalize("NFKC").toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "")
    .slice(0, 48) || label;
  const digest = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
  return `${readable}-${digest}`;
}

export const domainEntityId = (projectId: string, immutableKey: string): string =>
  stableEntityId("domain", projectId, durableNativeKey("domain", immutableKey));

export const specDocumentEntityId = (projectId: string, immutableKey: string): string =>
  stableEntityId("spec-document", projectId, durableNativeKey("spec", immutableKey));

export const specClauseEntityId = (projectId: string, immutableKey: string): string =>
  stableEntityId("spec-clause", projectId, durableNativeKey("clause", immutableKey));

export function codeSymbolEntityId(
  projectId: string,
  language: string,
  qualifiedSymbol: string,
  sourceIdentity: string,
): string {
  return stableEntityId(
    "code-symbol",
    projectId,
    `${durableNativeKey("language", language)}/${durableNativeKey("symbol", `${qualifiedSymbol}\n${sourceIdentity}`)}`,
  );
}

export const programDomainEntityId = (projectId: string, immutableKey: string): string =>
  stableEntityId("program-domain", projectId, durableNativeKey("program-domain", immutableKey));

export const sceneEntityId = (projectId: string, nativeIdentity: string): string =>
  stableEntityId("scene", projectId, durableNativeKey("scene", nativeIdentity));

export function sceneElementEntityId(projectId: string, sceneId: string, nativeIdentity: string): string {
  return stableEntityId(
    "scene-element",
    projectId,
    `${durableNativeKey("scene", sceneId)}/${durableNativeKey("element", nativeIdentity)}`,
  );
}

export function isProvisionalEntityId(id: string): boolean {
  return id.endsWith("?provisional=1");
}

export interface EntityAlias {
  entityId: string;
  alias: string;
  revision: string;
}

export function entityAlias(entityId: string, alias: string, revision: string): EntityAlias {
  if (!entityId.includes(":")) throw new Error("entityId is not typed");
  if (!alias.trim()) throw new Error("alias must not be empty");
  if (!revision.trim()) throw new Error("alias revision must not be empty");
  return { entityId, alias: alias.trim(), revision: revision.trim() };
}
