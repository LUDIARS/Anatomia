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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  WebCacheManifest,
  WebViewEnvelope,
  WebViewName,
  WebCacheBundle,
} from "./types.js";
import { WEB_VIEWS } from "./types.js";

/** The web-cache directory for a project, given its cache dir. */
export function webDir(projectCacheDir: string): string {
  return join(projectCacheDir, "web");
}

/** Sanitise a view name to a safe filename stem (defensive; names are fixed). */
function viewFile(view: WebViewName): string {
  return `${view.replace(/[^a-z0-9_-]/gi, "_")}.json`;
}

/**
 * Write a full prepared bundle: one envelope file per view + the manifest. Every
 * file gets the same `preparedAt`/`fingerprint` stamp so the run is coherent.
 */
export async function writeWebCache(
  projectCacheDir: string,
  projectId: string,
  fingerprint: string,
  bundle: WebCacheBundle,
  preparedAt: string,
): Promise<WebCacheManifest> {
  const dir = webDir(projectCacheDir);
  await mkdir(dir, { recursive: true });

  const counts: WebCacheManifest["counts"] = {};
  for (const view of WEB_VIEWS) {
    const data = bundle[view];
    const env: WebViewEnvelope = {
      version: 1,
      view,
      preparedAt,
      fingerprint,
      data,
    };
    await writeFile(join(dir, viewFile(view)), JSON.stringify(env), "utf8");
    counts[view] = countOf(view, data);
  }

  const manifest: WebCacheManifest = {
    version: 1,
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
    return m && m.version === 1 ? m : null;
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
    return env && env.version === 1 ? env : null;
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
    if (view === "graph" && Array.isArray(o["nodes"])) return (o["nodes"] as unknown[]).length;
  }
  return 0;
}
