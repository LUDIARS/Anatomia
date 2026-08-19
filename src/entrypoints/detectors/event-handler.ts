/**
 * src/entrypoints/detectors/event-handler.ts — Event subscriptions
 * (`class: event-handler`).
 *
 * Control enters an event handler from the outside with no caller inside the
 * repo, so without this detector every handler subtree looks unrooted. Covers
 * the `.on(name, handler)` family (Node emitters, Discord clients, DOM
 * `addEventListener`), MCP `server.tool(name, ..., handler)`, and C# `+=` event
 * subscription.
 *
 * SRP: event entry detection only.
 */

import type { EntryPointSeed } from "../types.js";
import type { Detector } from "./types.js";
import { conventionSources, isJsFamily, seedForName } from "./scan.js";

/** `emitter.on("evt", handler)` / `el.addEventListener("click", handler)`. */
const ON_SUBSCRIBE =
  /\.\s*(on|once|addEventListener|addListener)\s*\(\s*[`'"]([\w:.-]+)[`'"]\s*,\s*([A-Za-z_$][\w$]*)\s*[,)]/g;

/** MCP `server.tool("name", schema, handler)` — the tool call IS the entry. */
const MCP_TOOL =
  /\.\s*tool\s*\(\s*[`'"]([\w:.-]+)[`'"][\s\S]{0,200}?,\s*([A-Za-z_$][\w$]*)\s*\)/g;

/** C# `Something.Event += Handler;`. */
const CSHARP_SUBSCRIBE = /\b([A-Za-z_][\w.]*)\s*\+=\s*(?:new\s+\w+\s*\(\s*)?([A-Za-z_]\w*)\s*\)?\s*;/g;

export const detectEventHandler: Detector = (input) => {
  const seeds: EntryPointSeed[] = [];
  for (const [path, text] of conventionSources(input)) {
    if (isJsFamily(path)) {
      for (const match of text.matchAll(ON_SUBSCRIBE)) {
        const [, api, event, handler] = match;
        if (!handler) continue;
        const seed = seedForName(input, path, handler, "event-handler", "event-handler",
          `${api}("${event}") → ${handler}() in ${path}`);
        if (seed) seeds.push(seed);
      }
      for (const match of text.matchAll(MCP_TOOL)) {
        const [, tool, handler] = match;
        if (!handler) continue;
        const seed = seedForName(input, path, handler, "event-handler", "event-handler",
          `tool("${tool}") → ${handler}() in ${path}`);
        if (seed) seeds.push(seed);
      }
      continue;
    }
    if (!path.endsWith(".cs")) continue;
    for (const match of text.matchAll(CSHARP_SUBSCRIBE)) {
      const [, event, handler] = match;
      if (!handler) continue;
      const seed = seedForName(input, path, handler, "event-handler", "event-handler",
        `${event} += ${handler} in ${path}`);
      if (seed) seeds.push(seed);
    }
  }
  return seeds;
};
