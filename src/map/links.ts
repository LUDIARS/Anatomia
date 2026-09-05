/**
 * src/map/links.ts — Cross-project edges from spec text (design §12.2-4).
 *
 * The map is only useful across repos if it says WHO ELSE a piece of content
 * talks to: 「トランポリンカウンター」 is not implementable without knowing that
 * jump detection lives in Interpres. Two deterministic signals carry that,
 * and both are already written in the specs LUDIARS keeps:
 *
 *   1. another project's full name or short code (roster from project-codes.ts)
 *   2. an HTTP surface — `loopback <port>` or a `/api/...` route
 *
 * Both are matched on the record's OWN text (its declaration description and
 * its spec document), so an edge always has a quotable source. Nothing here
 * infers an edge from code structure — that is the knowledge graph's job.
 *
 * SRP: text → links. No I/O.
 */
// @implements SPEC-domain-map

import type { DomainMapLink } from "./types.js";
import type { ProjectCode } from "./project-codes.js";

/** At most this many links per record — a record is a signpost, not a report. */
const MAX_LINKS = 6;

/** Short codes below this length are ignored unless they are word-isolated. */
const CODE_MIN_LENGTH = 2;

/**
 * Links found in `text`.
 *
 * `selfProject` is excluded: a Ludellus spec naturally says "Ludellus", and an
 * edge from a project to itself is noise in every view that renders these.
 */
export function extractLinks(
  text: string,
  roster: ProjectCode[],
  selfProject: string,
): DomainMapLink[] {
  if (!text) return [];
  const links = new Map<string, DomainMapLink>();

  for (const project of roster) {
    if (project.id === selfProject) continue;
    const via = mentionOf(text, project);
    if (!via) continue;
    links.set(`p:${project.id}`, {
      project: project.id,
      kind: "project",
      name: project.name,
      via,
    });
  }

  for (const route of httpSurfaces(text)) {
    links.set(`s:${route}`, {
      project: selfProject,
      kind: "service",
      name: route,
      via: route,
    });
  }

  return [...links.values()].slice(0, MAX_LINKS);
}

/**
 * The literal mention that justifies a project link, or null.
 *
 * A full name matches anywhere (project names are distinctive words). A short
 * code must stand alone — `Ip` inside "Zip" or "Script" is not a mention, and
 * the two-letter codes would otherwise link nearly every document to nearly
 * every project.
 */
function mentionOf(text: string, project: ProjectCode): string | null {
  if (project.name.length >= 3 && new RegExp(escape(project.name), "i").test(text)) {
    return project.name;
  }
  if (project.code.length >= CODE_MIN_LENGTH) {
    const isolated = new RegExp(`(^|[^A-Za-z0-9_])${escape(project.code)}([^A-Za-z0-9_]|$)`);
    if (isolated.test(text)) return project.code;
  }
  return null;
}

/** `loopback <port>` and `/api/...` routes, de-duplicated in first-seen order. */
export function httpSurfaces(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/\bloopback[\s:]+(\d{2,5})\b/gi)) {
    out.add(`loopback ${match[1]}`);
  }
  for (const match of text.matchAll(/(?:^|[\s(`"'])(\/api\/[A-Za-z0-9_:\-/.]*)/g)) {
    out.add(match[1]!.replace(/[.,)`"']+$/, ""));
  }
  return [...out];
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
