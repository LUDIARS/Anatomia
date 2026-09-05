/**
 * src/web-cache/store.ts — Persist + read the prepared web-display cache.
 *
 * Layout (under a project's cache dir <cacheRoot>/<projectId>/):
 *   web/manifest.json        — WebCacheManifest (the index)
 *   web/<view>.json          — WebViewEnvelope<T> per view (own preparedAt)
 *
 * Unlike the fingerprint-keyed render artifacts (project/cache.ts), these files
 * are read back REGARDLESS of the current source fingerprint — the panel shows
 * the last prepared data even after the source changed (web data need not be
 * fresh). The fingerprint is recorded so the panel can flag "source changed".
 *
 * SRP: filesystem read/write of the web cache. No building, no HTTP.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  WebCacheManifest,
  WebViewEnvelope,
  WebViewName,
  WebCacheBundle,
} from "./types.js";
import { WEB_CACHE_SCHEMA_VERSION, WEB_VIEWS } from "./types.js";
import type { GraphSliceMap, GraphSlicePayload } from "./graph-split.js";
import type { GraphViewMode } from "../project/profile.js";

/** The web-cache directory for a project, given its cache dir. */
export function webDir(projectCacheDir: string): string {
  return join(projectCacheDir, "web");
}

/** Sanitise a view name to a safe filename stem (defensive; names are fixed). */
function viewFile(view: WebViewName): string {
  return `${view.replace(/[^a-z0-9_-]/gi, "_")}.json`;
}

/** Directory holding the per-group graph slices for one view mode. */
function sliceDir(projectCacheDir: string, mode: GraphViewMode): string {
  return join(webDir(projectCacheDir), "graph-slices", mode);
}

const GRAPH_SLICE_KEY = /^[0-9a-f]{16}$/i;

/** Stage every slice, then rotate the complete directory into service. */
async function writeGraphSlices(
  projectCacheDir: string,
  graphSlices: GraphSliceMap,
  preparedAt: string,
  fingerprint: string,
): Promise<void> {
  const activeDir = join(webDir(projectCacheDir), "graph-slices");
  const nonce = randomUUID();
  const stagedDir = `${activeDir}.tmp-${nonce}`;
  const previousDir = `${activeDir}.old-${nonce}`;
  let movedPrevious = false;
  try {
    for (const mode of ["function", "class"] as const) {
      const modeDir = join(stagedDir, mode);
      await mkdir(modeDir, { recursive: true });
      for (const [key, slice] of Object.entries(graphSlices[mode])) {
        if (!GRAPH_SLICE_KEY.test(key)) {
          throw new Error(`invalid graph slice key: ${key}`);
        }
        const env: WebViewEnvelope<GraphSlicePayload> = {
          version: WEB_CACHE_SCHEMA_VERSION,
          view: "graph",
          preparedAt,
          fingerprint,
          data: slice,
        };
        await writeFile(
          join(modeDir, `${key.toLowerCase()}.json`),
          JSON.stringify(env),
          "utf8",
        );
      }
    }

    try {
      await rename(activeDir, previousDir);
      movedPrevious = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    try {
      await rename(stagedDir, activeDir);
    } catch (err) {
      if (movedPrevious) await rename(previousDir, activeDir);
      throw err;
    }
    if (movedPrevious) {
      try {
        await rm(previousDir, { recursive: true, force: true });
      } catch {
        // The new complete directory is active; stale-backup cleanup is best effort.
      }
    }
  } finally {
    try {
      await rm(stagedDir, { recursive: true, force: true });
    } catch {
      // The active directory was either preserved or rotated; temp cleanup is best effort.
    }
  }
}

/**
 * Write a full prepared bundle: one envelope file per view + the manifest. Every
 * file gets the same `preparedAt`/`fingerprint` stamp so the run is coherent.
 * When `graphSlices` is present, each per-group slice is written under
 * web/graph-slices/<mode>/<key>.json. The complete slice tree is staged and
 * rotated into place so readers see either the previous or the new run and a
 * re-prepare cannot leave stale groups behind.
 */
export async function writeWebCache(
  projectCacheDir: string,
  projectId: string,
  fingerprint: string,
  bundle: WebCacheBundle,
  preparedAt: string,
  graphSlices?: GraphSliceMap,
): Promise<WebCacheManifest> {
  const dir = webDir(projectCacheDir);
  await mkdir(dir, { recursive: true });

  if (graphSlices) {
    await writeGraphSlices(projectCacheDir, graphSlices, preparedAt, fingerprint);
  }

  const counts: WebCacheManifest["counts"] = {};
  for (const view of WEB_VIEWS) {
    const data = bundle[view];
    const env: WebViewEnvelope = {
      version: WEB_CACHE_SCHEMA_VERSION,
      view,
      preparedAt,
      fingerprint,
      data,
    };
    await writeFile(join(dir, viewFile(view)), JSON.stringify(env), "utf8");
    counts[view] = countOf(view, data);
  }

  const manifest: WebCacheManifest = {
    version: WEB_CACHE_SCHEMA_VERSION,
    projectId,
    preparedAt,
    fingerprint,
    views: [...WEB_VIEWS],
    counts,
  };
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );
  return manifest;
}

/** Read the manifest of a prepared cache (null when never prepared). */
export async function readWebManifest(
  projectCacheDir: string,
): Promise<WebCacheManifest | null> {
  try {
    const raw = await readFile(join(webDir(projectCacheDir), "manifest.json"), "utf8");
    const m = JSON.parse(raw) as WebCacheManifest;
    return m && m.version === WEB_CACHE_SCHEMA_VERSION ? m : null;
  } catch {
    return null;
  }
}

/** Read one prepared view envelope (null when that view was never prepared). */
export async function readWebView<T = unknown>(
  projectCacheDir: string,
  view: WebViewName,
): Promise<WebViewEnvelope<T> | null> {
  try {
    const raw = await readFile(join(webDir(projectCacheDir), viewFile(view)), "utf8");
    const env = JSON.parse(raw) as WebViewEnvelope<T>;
    return env && env.version === WEB_CACHE_SCHEMA_VERSION ? env : null;
  } catch {
    return null;
  }
}

/** Read one prepared graph slice (null when absent / never prepared). */
export async function readWebGraphSlice(
  projectCacheDir: string,
  mode: GraphViewMode,
  key: string,
): Promise<WebViewEnvelope<GraphSlicePayload> | null> {
  if (!GRAPH_SLICE_KEY.test(key)) return null;
  try {
    const raw = await readFile(
      join(sliceDir(projectCacheDir, mode), `${key.toLowerCase()}.json`),
      "utf8",
    );
    const env = JSON.parse(raw) as WebViewEnvelope<GraphSlicePayload>;
    return env && env.version === WEB_CACHE_SCHEMA_VERSION ? env : null;
  } catch {
    return null;
  }
}

/** A small, view-appropriate entry count for the manifest badge. */
function countOf(view: WebViewName, data: unknown): number {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (view === "scene-modules" && Array.isArray(o["domains"])) return (o["domains"] as unknown[]).length;
    if (view === "search-corpus" && Array.isArray(o["entries"])) return (o["entries"] as unknown[]).length;
    if (view === "domain-view" && Array.isArray(o["views"])) return (o["views"] as unknown[]).length;
    if (view === "domain-map" && Array.isArray(o["records"])) return (o["records"] as unknown[]).length;
    if (view === "business-domain-view" && Array.isArray(o["domains"])) return (o["domains"] as unknown[]).length;
    if (view === "program-domain-view" && Array.isArray(o["layers"])) return (o["layers"] as unknown[]).length;
    if (view === "scene-view" && Array.isArray(o["scenes"])) return (o["scenes"] as unknown[]).length;
    if (view === "entrypoint-view" && Array.isArray(o["entries"])) return (o["entries"] as unknown[]).length;
    if (view === "graph") {
      if (Array.isArray(o["nodes"])) return (o["nodes"] as unknown[]).length;
      const summary = o["summary"];
      if (
        o["schema"] === "graph-overview-v1"
        && summary && typeof summary === "object"
        && typeof (summary as Record<string, unknown>)["funcCount"] === "number"
      ) {
        return (summary as Record<string, number>)["funcCount"] ?? 0;
      }
    }
  }
  return 0;
}
