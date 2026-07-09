/** Type declarations for the browser-served cache-view panel logic. */

export interface ModuleAccess {
  targetModuleId?: string;
  targetLabel?: string;
  targetDomains?: string[];
  count?: number;
  kinds?: Record<string, number>;
}
export function formatAccess(access: ModuleAccess | null | undefined): string;

export interface SceneRow {
  id?: string;
  label?: string;
}
export function scenesForFilter<T extends SceneRow>(
  payload: { scenes?: T[] } | null | undefined,
  sceneId: string | null | undefined,
): T[];

export interface ManifestSummary {
  prepared: boolean;
  stale: boolean;
  ready: boolean;
  label: string;
}
export function manifestSummary(
  manifest:
    | { prepared?: boolean; preparedAt?: string; stale?: boolean }
    | null
    | undefined,
): ManifestSummary;

export interface SearchResult {
  kind?: string;
  ref?: string;
  title?: string;
  file?: string;
  line?: number;
  domains?: string[];
  module?: string;
  reason?: string;
}
export function searchResultLabel(
  result: SearchResult | null | undefined,
): string;
