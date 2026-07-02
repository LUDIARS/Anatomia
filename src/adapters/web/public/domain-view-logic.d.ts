/** Type declarations for the browser-served pure panel logic. */

export function unitOfFile(file: string): string;

export interface AccessRow {
  name: string;
  kind: string;
  target?: string;
  file: string;
  how: string;
}
export function accessRowsFor(
  accessPatterns: Array<{
    name: string;
    kind: string;
    target?: string;
    file: string;
    accessors: Array<{ domain: string; access: string }>;
  }> | null | undefined,
  domainName: string,
): AccessRow[];

/**
 * Precomputed per-domain aggregate (server-built; src/domains/view-graph.ts).
 * The fold-independent half the panel renders from.
 */
export interface DomainUnitAggregate {
  units: string[];
  unit: Record<string, { count: number; color: string | null; fns: string[] }>;
  pairs: Array<{ from: string; to: string; w: number }>;
  totalUnits: number;
  totalFns: number;
}
export interface FoldedUnitGraph {
  visiblePairs: Array<{ from: string; to: string; w: number }>;
  hub: Record<string, 1>;
  degreeByGroup: Record<string, number>;
  foldedHubs: number;
  foldedEdges: number;
}
export function foldUnitGraph(
  agg: DomainUnitAggregate,
  opts: { fold: boolean },
): FoldedUnitGraph;

/** Screen row for the Domain View panel (screens belonging to a domain). */
export interface ScreenRow {
  name: string;
  kind: string;
  stack: string;
  route: string | null;
  file: string;
}
export function screensRowsFor(
  screens:
    | Array<{
        name: string;
        kind: string;
        stack: string;
        route?: string | null;
        file: string;
        domains?: string[];
      }>
    | null
    | undefined,
  domainName: string,
): ScreenRow[];
