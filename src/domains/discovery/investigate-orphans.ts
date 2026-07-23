import { createHash } from 'node:crypto';
import { relative } from 'node:path';

import type { AnalysisContext } from '../../core.js';
import type { ModuleGranularity } from '../../modules/index.js';
import { evaluateModulesFromGraph } from '../../modules/index.js';
import type { AnchorId, FunctionNode } from '../../types.js';

const DEFAULT_MIN_GROUP_FUNCTIONS = 3;
const DEFAULT_GRANULARITY: ModuleGranularity = 'dir';

type AnchoredFunctionNode = FunctionNode & {
  readonly id: AnchorId;
  readonly signatureShape: string;
};

export interface OrphanInvestigationOptions {
  /** Minimum number of functions required to propose a group as a domain. */
  readonly minGroupFunctions?: number;
  /** Existing module boundary used to group orphan functions. */
  readonly granularity?: ModuleGranularity;
}

export interface OrphanFunctionLocation {
  readonly anchor: AnchorId;
  readonly name: string;
  readonly signature: string;
  /** Normalized namespace/class + function + parameter/return type identity. */
  readonly signatureShape: string;
  /** Owning type name, or null for a free function. */
  readonly enclosingType: string | null;
  readonly reason: 'unassigned-domain';
  /** Repository-relative path using forward slashes. */
  readonly file: string;
  /** One-based inclusive start line. */
  readonly line: number;
  /** One-based inclusive end line. */
  readonly endLine: number;
}

export interface OrphanFeatureGroup {
  /** Stable SHA-256 of the sorted function evidence in this group. */
  readonly groupId: string;
  /** Module identifier produced by the existing module evaluator. */
  readonly moduleId: string;
  readonly kind: string;
  readonly label: string;
  readonly size: number;
  readonly functionCount: number;
  readonly cohesion: number;
  readonly functions: readonly OrphanFunctionLocation[];
}

export interface OrphanInvestigation {
  /** Stable SHA-256 of all sorted orphan-function evidence. */
  readonly snapshotId: string;
  readonly functions: readonly OrphanFunctionLocation[];
  readonly groups: readonly OrphanFeatureGroup[];
  readonly candidateGroups: readonly OrphanFeatureGroup[];
  readonly remainingFunctions: readonly OrphanFunctionLocation[];
  readonly minGroupFunctions: number;
  readonly granularity: ModuleGranularity;
}

/**
 * Finds functions that are not owned by any current domain implementor, then
 * groups them with the same deterministic module boundaries used elsewhere.
 * This is evidence only: it does not mutate domains or promote any group.
 */
export async function investigateOrphanFunctions(
  context: AnalysisContext,
  options: OrphanInvestigationOptions = {},
): Promise<OrphanInvestigation> {
  const minGroupFunctions = options.minGroupFunctions ?? DEFAULT_MIN_GROUP_FUNCTIONS;
  const granularity = options.granularity ?? DEFAULT_GRANULARITY;

  if (!Number.isInteger(minGroupFunctions) || minGroupFunctions < 1) {
    throw new RangeError('minGroupFunctions must be a positive integer');
  }

  const incompleteIdentity = context.functions.filter(
    (node) => node.id === null || !node.signatureShape,
  );
  if (incompleteIdentity.length > 0) {
    const sample = incompleteIdentity
      .slice(0, 3)
      .map((node) => `${toRepoRelativePath(context.repoPath, node.sourceRange.filePath)}:${node.sourceRange.start.line + 1} ${node.name}`)
      .join(', ');
    throw new Error(
      `orphan investigation requires Anchor IDs and signature shapes for every function; missing ${incompleteIdentity.length}: ${sample}`,
    );
  }

  const assignedAnchors = new Set<AnchorId>(
    (context.domains ?? []).flatMap((domain) => domain.implementors),
  );
  const orphanNodes = [...context.functions]
    .filter(hasAnchor)
    .filter((node) => !assignedAnchors.has(node.id))
    .sort(compareFunctionNodes);
  const functions = orphanNodes.map((node) => toFunctionLocation(context.repoPath, node));
  const snapshotId = hashFunctionEvidence(functions);

  if (orphanNodes.length === 0) {
    return {
      snapshotId,
      functions,
      groups: [],
      candidateGroups: [],
      remainingFunctions: [],
      minGroupFunctions,
      granularity,
    };
  }

  const { evaluation, modules } = await evaluateModulesFromGraph(
    context.graph,
    orphanNodes,
    granularity,
  );
  const cohesionByModule = new Map(
    evaluation.cohesion.map((item) => [item.moduleId, item.cohesion] as const),
  );
  const functionByAnchor = new Map(functions.map((item) => [item.anchor, item] as const));

  const groups = modules
    .map((module): OrphanFeatureGroup | undefined => {
      const groupFunctions = module.anchors
        .map((anchor) => functionByAnchor.get(anchor))
        .filter((item): item is OrphanFunctionLocation => item !== undefined)
        .sort(compareFunctionLocations);

      if (groupFunctions.length === 0) {
        return undefined;
      }

      return {
        groupId: hashFunctionEvidence(groupFunctions),
        moduleId: module.id,
        kind: module.kind,
        label: normalizeSlashes(module.label),
        size: groupFunctions.length,
        functionCount: groupFunctions.length,
        cohesion: cohesionByModule.get(module.id) ?? 0,
        functions: groupFunctions,
      };
    })
    .filter((group): group is OrphanFeatureGroup => group !== undefined)
    .sort(compareGroups);
  const candidateGroups = groups.filter((group) => group.size >= minGroupFunctions);
  const candidateAnchors = new Set(
    candidateGroups.flatMap((group) => group.functions.map((item) => item.anchor)),
  );
  const remainingFunctions = functions.filter((item) => !candidateAnchors.has(item.anchor));

  return {
    snapshotId,
    functions,
    groups,
    candidateGroups,
    remainingFunctions,
    minGroupFunctions,
    granularity,
  };
}

function hasAnchor(node: FunctionNode): node is AnchoredFunctionNode {
  return node.id !== null && typeof node.signatureShape === 'string' && node.signatureShape.length > 0;
}

function toFunctionLocation(repoPath: string, node: AnchoredFunctionNode): OrphanFunctionLocation {
  return {
    anchor: node.id,
    name: node.name,
    signature: node.signature,
    signatureShape: node.signatureShape,
    enclosingType: node.enclosingType ?? null,
    reason: 'unassigned-domain',
    file: toRepoRelativePath(repoPath, node.sourceRange.filePath),
    line: node.sourceRange.start.line + 1,
    endLine: node.sourceRange.end.line + 1,
  };
}

function toRepoRelativePath(repoPath: string, filePath: string): string {
  const normalizedRepo = trimTrailingSlash(normalizeSlashes(repoPath));
  const normalizedFile = normalizeSlashes(filePath);
  const repoPrefix = `${normalizedRepo}/`;

  if (normalizedFile.toLowerCase().startsWith(repoPrefix.toLowerCase())) {
    return normalizedFile.slice(repoPrefix.length);
  }

  return normalizeSlashes(relative(repoPath, filePath));
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/u, '') : path;
}

function normalizeSlashes(path: string): string {
  return path.replace(/\\/gu, '/');
}

function hashFunctionEvidence(functions: readonly OrphanFunctionLocation[]): string {
  const sortedEvidence = [...functions]
    .sort(compareFunctionLocations)
    .map((item) =>
      JSON.stringify([
        item.file,
        item.line,
        item.endLine,
        item.anchor,
        item.name,
        item.signature,
        item.signatureShape,
        item.enclosingType,
      ]),
    );

  return createHash('sha256').update(sortedEvidence.join('\n')).digest('hex');
}

function compareFunctionNodes(left: AnchoredFunctionNode, right: AnchoredFunctionNode): number {
  return compareFunctionLocations(
    {
      anchor: left.id,
      name: left.name,
      signature: left.signature,
      signatureShape: left.signatureShape,
      enclosingType: left.enclosingType ?? null,
      file: normalizeSlashes(left.sourceRange.filePath),
      line: left.sourceRange.start.line,
      endLine: left.sourceRange.end.line,
    },
    {
      anchor: right.id,
      name: right.name,
      signature: right.signature,
      signatureShape: right.signatureShape,
      enclosingType: right.enclosingType ?? null,
      file: normalizeSlashes(right.sourceRange.filePath),
      line: right.sourceRange.start.line,
      endLine: right.sourceRange.end.line,
    },
  );
}

function compareFunctionLocations(
  left: Pick<OrphanFunctionLocation, 'anchor' | 'name' | 'signature' | 'signatureShape' | 'enclosingType' | 'file' | 'line' | 'endLine'>,
  right: Pick<OrphanFunctionLocation, 'anchor' | 'name' | 'signature' | 'signatureShape' | 'enclosingType' | 'file' | 'line' | 'endLine'>,
): number {
  return (
    compareStrings(left.file, right.file) ||
    left.line - right.line ||
    left.endLine - right.endLine ||
    compareStrings(String(left.anchor), String(right.anchor)) ||
    compareStrings(left.name, right.name) ||
    compareStrings(left.signature, right.signature) ||
    compareStrings(left.signatureShape, right.signatureShape) ||
    compareStrings(left.enclosingType ?? '', right.enclosingType ?? '')
  );
}

function compareGroups(left: OrphanFeatureGroup, right: OrphanFeatureGroup): number {
  return (
    compareStrings(left.label, right.label) ||
    compareStrings(left.kind, right.kind) ||
    compareStrings(left.groupId, right.groupId)
  );
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
