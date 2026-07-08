/**
 * web-views-logic.js — pure data-shaping for the cache-backed Web views.
 *
 * The cache-backed panels (Scenes, Search, the manifest summary strip) need
 * small amounts of pure logic — formatting an access row, filtering scene rows,
 * summarising a manifest, labelling a search result. Keeping these here (no DOM,
 * no fetch) lets vitest regression-test them and lets the browser reuse the
 * exact same code.
 *
 * Loaded in the browser as an ES module (`/web-views-logic.js`), which also
 * publishes the API on `window.WebViewsLogic` for index.html's classic inline
 * scripts. Imported directly by the test.
 */

// Stable ordering for access-kind labels, so "→ ui (calls 3, reads 1)" reads
// the same way regardless of the object key order the backend emitted.
const KIND_ORDER = [
  "calls",
  "reads",
  "writes",
  "depends",
  "implements",
  "overrides",
  "includes",
];

/**
 * Format one module→module access row into a display string.
 *
 *   { targetLabel:"ui", kinds:{ reads:1, calls:3 } }  →  "→ ui (calls 3, reads 1)"
 *
 * Kinds are listed in KIND_ORDER first (calls, reads, writes, …), any unknown
 * kinds after them in their own insertion order. Zero / falsy counts are
 * dropped. With no kinds at all, just the target arrow is returned.
 *
 * @param {{targetLabel?:string, targetModuleId?:string, kinds?:Record<string,number>}} access
 * @returns {string}
 */
export function formatAccess(access) {
  const a = access || {};
  const label = a.targetLabel || a.targetModuleId || "?";
  const kinds = a.kinds || {};
  const seen = {};
  const ordered = [];
  KIND_ORDER.forEach((k) => {
    if (kinds[k]) {
      ordered.push(k);
      seen[k] = 1;
    }
  });
  Object.keys(kinds).forEach((k) => {
    if (!seen[k] && kinds[k]) ordered.push(k);
  });
  const parts = ordered.map((k) => k + " " + kinds[k]);
  return "→ " + label + (parts.length ? " (" + parts.join(", ") + ")" : "");
}

/**
 * The scenes to render for a selected scene id. A null/empty sceneId means "no
 * filter" → every scene in payload order.
 *
 * @param {{scenes?: Array<{id?:string}>}} payload
 * @param {string|null|undefined} sceneId
 * @returns {Array<{id?:string}>} scene rows (in payload order)
 */
export function scenesForFilter(payload, sceneId) {
  const scenes = (payload && payload.scenes) || [];
  if (!sceneId) return scenes;
  return scenes.filter((s) => s && s.id === sceneId);
}

/**
 * Local datetime string for an ISO timestamp, or a fallback when absent.
 * Pure-ish: relies only on the Date the runtime provides.
 */
function localTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleString();
}

/**
 * Summarise a `/web/manifest` response for the dashboard summary strip.
 *
 *   { prepared:false }                               → { prepared:false, stale:false, label:"未生成" }
 *   { prepared:true, preparedAt:"…", stale:true }    → { prepared:true,  stale:true,  label:"<local datetime>" }
 *
 * @param {{prepared?:boolean, preparedAt?:string, stale?:boolean}|null|undefined} manifest
 * @returns {{prepared:boolean, stale:boolean, label:string}}
 */
export function manifestSummary(manifest) {
  const m = manifest || {};
  if (!m.prepared) {
    return { prepared: false, stale: false, label: "未生成" };
  }
  return {
    prepared: true,
    stale: !!m.stale,
    label: localTime(m.preparedAt) || "生成済",
  };
}

/**
 * Display string for one search result. Shows the title, then a dimmable
 * `file:line` suffix when present, e.g. `"loadGraph  ·  src/web/index.html:882"`.
 * Used by the Search panel; the panel adds the kind badge + reason separately.
 *
 * @param {{title?:string, ref?:string, file?:string, line?:number}} result
 * @returns {string}
 */
export function searchResultLabel(result) {
  const r = result || {};
  const title = r.title || r.ref || "(untitled)";
  if (r.file) {
    return title + " · " + r.file + (r.line != null ? ":" + r.line : "");
  }
  return title;
}

// Publish for the panel's classic inline scripts when loaded in a browser.
if (typeof window !== "undefined") {
  window.WebViewsLogic = {
    formatAccess,
    scenesForFilter,
    manifestSummary,
    searchResultLabel,
  };
}
