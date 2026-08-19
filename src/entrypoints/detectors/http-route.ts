/**
 * src/entrypoints/detectors/http-route.ts — HTTP handlers (`class: http-route`).
 *
 * Two shapes cover the TS/JS web stacks Anatomia sees:
 *   - imperative route tables — `app.get("/x", handler)` (Hono / Express and the
 *     dozens of frameworks that copied that signature);
 *   - Next file routes — `app/**\/route.ts` (exported HTTP verbs) and
 *     `pages/api/**` (the default export).
 *
 * An inline arrow handler has no anchor of its own; the enclosing registration
 * is not an entry either (its body is the handler). Those are left to the
 * frontier rather than attributed to a wrong symbol.
 *
 * SRP: HTTP entry detection only.
 */

import type { EntryPointSeed } from "../types.js";
import type { Detector } from "./types.js";
import { conventionSources, isJsFamily, seedForName } from "./scan.js";

/** `app.get("/path", handler)` / `router.post('/x', handler)`. */
const ROUTE_CALL =
  /\b(?:app|router|server|api)\s*\.\s*(get|post|put|patch|delete|options|head|all)\s*\(\s*[`'"]([^`'"]*)[`'"]\s*,\s*([A-Za-z_$][\w$]*)\s*[,)]/g;

/** Next app-router route file: `app/**\/route.ts`. */
const NEXT_ROUTE_FILE = /(?:^|\/)app\/.*\/route\.[jt]sx?$/;
/** Next pages-router API file: `pages/api/**`. */
const NEXT_API_FILE = /(?:^|\/)pages\/api\/.+\.[jt]sx?$/;

const HTTP_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);

export const detectHttpRoute: Detector = (input) => {
  const seeds: EntryPointSeed[] = [];
  for (const [path, text] of conventionSources(input)) {
    if (!isJsFamily(path)) continue;

    for (const match of text.matchAll(ROUTE_CALL)) {
      const [, verb, route, handler] = match;
      if (!verb || !handler) continue;
      const seed = seedForName(input, path, handler, "http-route", "http-route",
        `${verb.toUpperCase()} ${route ?? ""} → ${handler}() in ${path}`);
      if (seed) seeds.push(seed);
    }

    if (NEXT_ROUTE_FILE.test(path)) {
      // The exported verb functions ARE the handlers; resolve by name in-file.
      for (const symbol of input.symbols.inFile(path)) {
        if (!HTTP_VERBS.has(symbol.name)) continue;
        seeds.push({
          anchor: symbol.anchor,
          entryClass: "http-route",
          detector: "http-route",
          reason: `Next route file ${path} exports ${symbol.name}`,
        });
      }
    }

    if (NEXT_API_FILE.test(path)) {
      const defaultExport = /\bexport\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(text);
      const name = defaultExport?.[1];
      if (name) {
        const seed = seedForName(input, path, name, "http-route", "http-route",
          `Next API route ${path} default export ${name}`);
        if (seed) seeds.push(seed);
      }
    }
  }
  return seeds;
};
