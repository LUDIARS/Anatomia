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

export interface VisNode {
  id: string;
  group?: string;
  color?: { background?: string };
  label?: string;
  _meta?: { name?: string };
}
export interface VisEdge {
  from: string;
  to: string;
}
export interface UnitGraph {
  units: string[];
  unit: Record<string, { count: number; color?: string; fns: string[] }>;
  nodeUnit: Record<string, string>;
  pairs: Array<{ from: string; to: string; w: number }>;
  visiblePairs: Array<{ from: string; to: string; w: number }>;
  hub: Record<string, 1>;
  degreeByGroup: Record<string, number>;
  foldedHubs: number;
  foldedEdges: number;
  totalUnits: number;
  totalFns: number;
}
export function buildDomainUnitGraph(
  implementors: string[],
  nodes: VisNode[],
  edges: VisEdge[],
  opts: { fold: boolean; maxUnits: number },
): UnitGraph;
