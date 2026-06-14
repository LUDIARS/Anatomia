/**
 * dag/ — Static content-address DAG layer (G1).
 *
 * Pipeline: parse (T03) -> extractFunctions (T04) -> normalize (T05) ->
 * hashFunction (T06) -> buildFileNode/buildRepoNode (T07). Plus diffFiles (T08)
 * and reindex (T09). Measurement harness lives in measure.ts (T10).
 */

export { parse } from "./parser.js";
export { extractFunctions } from "./extract.js";
export { normalize } from "./normalize.js";
export { hashFunction, assignAnchorId } from "./hash.js";
export { buildFileNode, buildRepoNode } from "./merkle.js";
export type { RepoNode } from "./merkle.js";
export { diffFiles } from "./diff.js";
export type { DiffResult } from "./diff.js";
export { reindex, buildFileNodeFromSource } from "./incremental.js";
export { measureCorpus } from "./measure.js";
export type { MeasureReport, CategoryReport } from "./measure.js";
