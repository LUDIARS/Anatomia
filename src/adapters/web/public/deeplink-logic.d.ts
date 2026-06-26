/** Type declarations for the browser-served deep-link panel logic. */

export interface Deeplink {
  project: string | null;
  focus: string | null;
}
export function parseDeeplink(search: string | null | undefined): Deeplink;

export interface DomainView {
  domain?: string;
}
export function findDomainMatch<T extends DomainView>(
  views: T[] | null | undefined,
  focus: string | null | undefined,
): T | null;

export interface SceneRef {
  id?: string;
  label?: string;
}
export function findSceneMatch(
  sceneModules: { scenes?: SceneRef[] } | null | undefined,
  focus: string | null | undefined,
): string | null;
