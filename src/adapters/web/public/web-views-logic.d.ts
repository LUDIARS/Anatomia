/** Type declarations for the browser-served cache-view panel logic. */

export interface ModuleAccess {
  targetModuleId?: string;
  targetLabel?: string;
  targetDomains?: string[];
  count?: number;
  kinds?: Record<string, number>;
}
export function formatAccess(access: ModuleAccess | null | undefined): string;

export interface SceneModuleDomain {
  domain: string;
  scenes?: string[];
}
export function domainsForScene(
  payload: { domains?: SceneModuleDomain[] } | null | undefined,
  sceneId: string | null | undefined,
): string[];

export interface ManifestSummary {
  prepared: boolean;
  stale: boolean;
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
