/**
 * src/web-cache/search-corpus.ts — Build the searchable corpus.
 *
 * The search view does NOT do client-side substring matching: it sends free text
 * to the server, where an LLM (Haiku) interprets the query and ranks over THIS
 * corpus (search.ts). The corpus is prepared once (with the rest of the web
 * cache) so a query never re-analyzes the repo — it ranks over a flat list of
 * functions / domains / modules / spec clauses.
 *
 * SRP: analyzed context + module index → flat SearchEntry list. No LLM, no HTTP.
 */

import { relative } from "node:path";
import type { AnchorId } from "../types.js";
import type { AnalysisContext } from "../core.js";
import type { ModuleEvaluation } from "../modules/types.js";
import type { SearchCorpus, SearchEntry } from "./types.js";

/** Max characters of free text kept per entry (keeps the corpus bounded). */
const TEXT_CAP = 400;

export async function buildSearchCorpus(
  ctx: AnalysisContext,
  evaluation: ModuleEvaluation,
  index: Map<AnchorId, string>,
): Promise<SearchCorpus> {
  const entries: SearchEntry[] = [];

  // anchor → owning domains, anchor → signature.
  const domainsByAnchor = new Map<AnchorId, string[]>();
  for (const d of ctx.domains ?? []) {
    for (const a of d.implementors) {
      const list = domainsByAnchor.get(a) ?? [];
      list.push(d.domain);
      domainsByAnchor.set(a, list);
    }
  }
  const sigById = new Map<string, string>();
  for (const fn of ctx.functions) {
    if (fn.id) sigById.set(fn.id, fn.signature);
  }

  // Functions / methods.
  const nodes = await ctx.graph.allNodes();
  for (const node of nodes) {
    if (node.kind !== "function" && node.kind !== "method") continue;
    let file = node.sourceRange.filePath;
    try {
      file = relative(ctx.repoPath, file).replace(/\\/g, "/");
    } catch {
      /* keep absolute */
    }
    entries.push({
      kind: "function",
      ref: node.id,
      title: node.name,
      file,
      line: node.sourceRange.start.line,
      domains: domainsByAnchor.get(node.id),
      module: index.get(node.id),
      text: sigById.get(node.id)?.slice(0, TEXT_CAP),
    });
  }

  // Domains.
  for (const d of ctx.domains ?? []) {
    if (d.implementors.length === 0) continue;
    entries.push({
      kind: "domain",
      ref: d.domain,
      title: d.domain,
      domains: [d.domain],
      text: `${d.implementors.length} functions; ${d.conforms ? "conforms" : `${d.violations.length} violations`}`,
    });
  }

  // Modules (structural).
  for (const m of evaluation.modules) {
    entries.push({
      kind: "module",
      ref: m.id,
      title: m.label,
      module: m.id,
      text: `${m.anchors.length} functions in ${m.files.length} files`,
    });
  }

  // Spec clauses.
  for (const cl of ctx.specClauses ?? []) {
    entries.push({
      kind: "spec",
      ref: cl.id,
      title: cl.heading,
      file: cl.sourceFile,
      text: cl.text.slice(0, TEXT_CAP),
    });
  }

  return { entries };
}
