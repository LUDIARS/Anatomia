/**
 * Shared test helpers for the supply layer tests.
 * Parses C++ source into a hashed FileNode + InMemoryCodeGraph, mirroring the
 * G1->G2 pipeline used elsewhere (graph/__tests__/build.test.ts).
 */

import { parse } from "../../dag/parser.js";
import { extractFunctions } from "../../dag/extract.js";
import { normalize } from "../../dag/normalize.js";
import { assignAnchorId } from "../../dag/hash.js";
import { buildFileNode } from "../../dag/merkle.js";
import { buildGraph, extractEdgeInfo } from "../../graph/build.js";
import { InMemoryCodeGraph } from "../../graph/in-memory.js";
import type { FileNode, FunctionNode } from "../../types.js";

export interface BuiltGraph {
  graph: InMemoryCodeGraph;
  file: FileNode;
  functions: FunctionNode[];
  idOf: Record<string, string>;
}

/** parse -> extract -> hash -> graph. Keeps the tree alive (no .delete()). */
export async function buildFromSource(src: string, path = "/t.cpp"): Promise<BuiltGraph> {
  const tree = await parse(src, "cpp");
  const functions = extractFunctions(tree, src, path);
  for (const fn of functions) assignAnchorId(fn, normalize(fn.bodyAst));
  const file = buildFileNode(path, functions);
  const edgeInfo = extractEdgeInfo([file]);
  const graph = new InMemoryCodeGraph(buildGraph([file], edgeInfo));
  const idOf: Record<string, string> = {};
  for (const fn of file.functions) idOf[fn.name] = fn.id!;
  return { graph, file, functions, idOf };
}
