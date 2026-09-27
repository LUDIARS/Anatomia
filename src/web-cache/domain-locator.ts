import { isAbsolute, relative } from "node:path";
import type { AnalysisContext } from "../core.js";
import type { BusinessDomainViewPayload, ProgramDomainViewPayload } from "./types.js";

export interface DomainFunction {
  anchor: string;
  name: string;
  path: string;
  line: number;
  comment: string | null;
  specRefs: string[];
}

export interface DomainLocatorEntry {
  id: string;
  layer: "business" | "program";
  name: string;
  functionCount: number;
  shard: string;
}

export interface DomainLocatorCatalog {
  version: 1;
  projectId: string;
  preparedAt: string;
  fingerprint: string;
  freshness: "unchecked";
  domains: DomainLocatorEntry[];
}

export interface DomainLocatorShard {
  id: string;
  functions: DomainFunction[];
}

export interface DomainLocatorBuild {
  domains: Array<Omit<DomainLocatorEntry, "shard"> & { functions: DomainFunction[] }>;
}

/** Only approved code evidence can populate business membership. */
export function buildDomainLocator(
  ctx: AnalysisContext,
  business: BusinessDomainViewPayload,
  program: ProgramDomainViewPayload,
  comments: ReadonlyMap<string, string> = new Map(),
): DomainLocatorBuild {
  const occurrences = new Map<string, DomainFunction[]>();
  const byLocation = new Map<string, DomainFunction[]>();
  for (const fn of ctx.functions) {
    if (!fn.id) continue;
    const path = isAbsolute(fn.sourceRange.filePath)
      ? relative(ctx.repoPath, fn.sourceRange.filePath).replace(/\\/g, "/")
      : fn.sourceRange.filePath.replace(/\\/g, "/");
    const row: DomainFunction = {
      anchor: String(fn.id), name: fn.name, path,
      line: fn.sourceRange.start.line,
      comment: comments.get(`${path}\0${fn.sourceRange.start.line}`) ?? null, specRefs: [],
    };
    occurrences.set(row.anchor, [...(occurrences.get(row.anchor) ?? []), row]);
    byLocation.set(`${row.path}\0${row.line}`, [...(byLocation.get(`${row.path}\0${row.line}`) ?? []), row]);
  }
  const matched = (file: string, line: number | null): DomainFunction[] => {
    // Knowledge CodeSymbol IDs differ from source Anchor IDs. An approved
    // correspondence supplies a location; only an unambiguous exact match lands.
    if (line === null) return [];
    const rows = byLocation.get(`${file.replace(/\\/g, "/")}\0${line}`) ?? [];
    return rows.length === 1 ? rows : [];
  };
  const unique = (rows: DomainFunction[]): DomainFunction[] => {
    const byLocation = new Map<string, DomainFunction>();
    for (const row of rows) byLocation.set(`${row.anchor}\0${row.path}\0${row.line}`, row);
    return [...byLocation.values()].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.anchor.localeCompare(b.anchor));
  };
  const domains: DomainLocatorBuild["domains"] = [];
  for (const domain of business.domains) {
    const refs = domain.specRefs.map((ref) => ref.id);
    const functions = unique(domain.programDomains.flatMap((relation) => relation.codeSymbols.flatMap((symbol) =>
      matched(symbol.file, symbol.line).map((row) => ({ ...row, specRefs: refs }))
    )));
    domains.push({ id: domain.id, layer: "business", name: domain.name, functionCount: functions.length, functions });
  }
  for (const layer of program.layers) for (const domain of layer.domains) {
    const refs = [...new Set(domain.businessDomains.flatMap((owner) => owner.evidence.specClauses.map((clause) => clause.id)))].sort();
    const functions = unique(domain.codeSymbolIds.flatMap((id) => (occurrences.get(id) ?? []).map((row) => ({ ...row, specRefs: refs }))));
    domains.push({ id: domain.id, layer: "program", name: domain.id, functionCount: functions.length, functions });
  }
  return { domains: domains.sort((a, b) => a.layer.localeCompare(b.layer) || a.id.localeCompare(b.id)) };
}
