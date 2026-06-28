/**
 * deeplink-logic.js — pure parsing / entity-matching for management-panel deep links.
 *
 * Thaleia (突合サービス) issues deep links INTO this panel of the form
 *   /?project=<anatomiaProjectId>&focus=<domain-or-screen>
 * (see Thaleia src/links/deeplink.ts → anatomiaFocusUrl). `project` selects the
 * registered Anatomia project; `focus` names the domain (anatomiaDomain) or the
 * screen/scene (anatomiaScreen) the link wants the panel to land on.
 *
 * This module is PURE (no DOM, no fetch): the panel does the navigation + focus
 * side-effects, this just (a) parses the query string and (b) resolves which
 * loaded entity a focus token matches. Matching is exact on name (case-folded)
 * — never a fuzzy/substring guess, so a focus that does not exist resolves to
 * null and the panel can surface it instead of silently landing elsewhere.
 *
 * Loaded in the browser as an ES module (`/deeplink-logic.js`), which also
 * publishes the API on `window.DeeplinkLogic` for index.html's classic inline
 * scripts. Imported directly by the vitest test.
 */

/** Case-folded, trimmed string for tolerant exact matching. */
function norm(s) {
  return String(s == null ? "" : s).trim().toLowerCase();
}

/**
 * Parse a deep-link query into its consumed params. Accepts a raw query string
 * (`"?project=a&focus=b"` or `"project=a&focus=b"`) or a full URL — anything
 * `URLSearchParams` can take after the leading `?` is stripped. Blank/whitespace
 * values resolve to null so callers can treat "absent" and "empty" alike.
 *
 * @param {string|null|undefined} search e.g. `window.location.search`
 * @returns {{project: string|null, focus: string|null}}
 */
export function parseDeeplink(search) {
  let qs = String(search == null ? "" : search);
  const qIdx = qs.indexOf("?");
  if (qIdx !== -1) qs = qs.slice(qIdx + 1);
  const params = new URLSearchParams(qs);
  const project = params.get("project");
  const focus = params.get("focus");
  return {
    project: project && project.trim() ? project.trim() : null,
    focus: focus && focus.trim() ? focus.trim() : null,
  };
}

/**
 * The Domain-View entry whose domain name matches `focus` (case-folded, exact),
 * or null when none matches. `views` is the `/web/domain-view` payload's view
 * list (`[{ domain, … }]`).
 *
 * @param {Array<{domain?:string}>|null|undefined} views
 * @param {string|null|undefined} focus
 * @returns {{domain?:string}|null}
 */
export function findDomainMatch(views, focus) {
  const list = Array.isArray(views) ? views : [];
  if (!focus) return null;
  const want = norm(focus);
  if (!want) return null;
  for (const v of list) {
    if (norm(v && v.domain) === want) return v;
  }
  return null;
}

/**
 * The scene id whose id OR label matches `focus` (case-folded, exact), or null
 * when none matches. `sceneModules` is the `/web/scene-modules` payload
 * (`{ scenes: [{ id, label? }] }`); a screen deep link (anatomiaScreen) lands on
 * the matching scene chip.
 *
 * @param {{scenes?: Array<{id?:string, label?:string}>}|null|undefined} sceneModules
 * @param {string|null|undefined} focus
 * @returns {string|null} the matching scene id (not the object)
 */
export function findSceneMatch(sceneModules, focus) {
  const scenes = (sceneModules && sceneModules.scenes) || [];
  if (!focus) return null;
  const want = norm(focus);
  if (!want) return null;
  for (const s of scenes) {
    if (norm(s && s.id) === want || norm(s && s.label) === want) {
      return (s && s.id) || null;
    }
  }
  return null;
}

// Publish for the panel's classic inline scripts when loaded in a browser.
if (typeof window !== "undefined") {
  window.DeeplinkLogic = {
    parseDeeplink,
    findDomainMatch,
    findSceneMatch,
  };
}
