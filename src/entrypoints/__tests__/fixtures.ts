/**
 * src/entrypoints/__tests__/fixtures.ts — Hermetic detector inputs.
 *
 * Detection is a pure function over already-read sources, so every case here is
 * built from literals: no temp dirs, no repo reads, no analyze().
 */

import type { AnchorId, AstNode, FileNode, FunctionNode, ParamInfo, TypeDecl } from "../../types.js";
import type { ScreenGraph, ScreenNode } from "../../screens/types.js";
import type { ProjectProfile } from "../../project/profile.js";
import type { DetectorInput, PackageManifest } from "../detectors/index.js";
import { defaultEntryPointConfig } from "../config.js";
import { SymbolIndex } from "../symbols.js";
import type { EntryPointConfig } from "../types.js";

export const ROOT = "/repo";

export const abs = (relPath: string): string => `${ROOT}/${relPath}`;

export interface FnSpec {
  name: string;
  path: string;
  /** 0-based declaration row, matching tree-sitter positions. */
  line?: number;
  enclosingType?: string;
  params?: ParamInfo[];
  signature?: string;
}

export function fn(spec: FnSpec): FunctionNode {
  const line = spec.line ?? 0;
  return {
    id: `${spec.path}#${spec.name}` as AnchorId,
    name: spec.name,
    signature: spec.signature ?? `void ${spec.name}()`,
    ...(spec.enclosingType ? { enclosingType: spec.enclosingType } : {}),
    ...(spec.params ? { params: spec.params } : {}),
    sourceRange: {
      start: { line, column: 0 },
      end: { line: line + 4, column: 0 },
      filePath: abs(spec.path),
    },
    bodyAst: { type: "block", children: [] } as unknown as AstNode,
  };
}

export function fileNode(path: string, functions: FunctionNode[], types: TypeDecl[] = []): FileNode {
  return { path: abs(path), hash: null, functions, types };
}

export function screen(partial: Partial<ScreenNode> & { name: string; file: string }): ScreenNode {
  return {
    line: 1, kind: "page", stack: "web", contains: [], navigatesTo: [],
    reason: "fixture", domains: [], ...partial,
  };
}

export function screenGraph(screens: ScreenNode[] = []): ScreenGraph {
  return {
    screens,
    summary: { total: screens.length, byStack: {}, byKind: {}, edges: 0 },
  };
}

export interface DetectorInputSpec {
  sources: Record<string, string>;
  functions: FunctionNode[];
  files?: FileNode[];
  screens?: ScreenNode[];
  config?: Partial<EntryPointConfig>;
  projectProfile?: ProjectProfile;
  packageManifest?: PackageManifest;
}

export function detectorInput(spec: DetectorInputSpec): DetectorInput {
  const config = { ...defaultEntryPointConfig(), ...spec.config };
  return {
    repoPath: ROOT,
    config,
    symbols: new SymbolIndex(ROOT, spec.functions),
    sources: new Map(Object.entries(spec.sources).sort((left, right) => left[0].localeCompare(right[0]))),
    files: spec.files ?? [],
    ...(spec.projectProfile ? { projectProfile: spec.projectProfile } : {}),
    screens: screenGraph(spec.screens ?? []),
    ...(spec.packageManifest ? { packageManifest: spec.packageManifest } : {}),
  };
}
