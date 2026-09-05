/**
 * src/map/format.ts — Render map hits for a human (design §12.3).
 *
 * The design fixes the shape of a hit line: 「プロダクト → コンテンツ → コア
 * ドメイン → 主要パス → 関連サービス」. It is one line because the map is a
 * PREFIX to real work — it is printed before a plan, before a delegation seed,
 * before the author opens an editor — and a paragraph there would be skipped.
 *
 * A zero-hit search prints the design's own wording (「索引に無い。新規コンテンツ
 * か表記ゆれ」) rather than nothing: "the index has no answer" is itself the
 * answer, and it is what `plan` turns into a question.
 *
 * SRP: rendering only.
 */
// @implements SPEC-domain-map

import type { DomainMapHit, ProjectDomainMap } from "./types.js";

/** The sentence a zero-hit search prints (and `plan` records as a question). */
export const NO_HIT_MESSAGE = "索引に無い。新規コンテンツか表記ゆれの可能性があります。";

/** How many paths one line shows before it truncates. */
const MAX_PATHS = 3;

/** Render a search result set. */
export function formatSearchHits(query: string, hits: DomainMapHit[]): string {
  const lines = [`ドメインマップ検索: ${query}`];
  if (hits.length === 0) {
    lines.push(`  ${NO_HIT_MESSAGE}`);
    return lines.join("\n");
  }
  hits.forEach((hit, at) => {
    lines.push(`  ${at + 1}. ${hitLine(hit)}`);
  });
  return lines.join("\n");
}

/** 「プロダクト → コンテンツ → コアドメイン → 主要パス → 関連サービス」 */
export function hitLine(hit: DomainMapHit): string {
  const parts = [hit.project, `${hit.name} [${hit.kind}]`];
  if (hit.coreDomain && hit.coreDomain !== hit.name) parts.push(hit.coreDomain);
  parts.push(hit.paths.length > 0 ? pathList(hit.paths) : "(パス宣言なし)");
  if (hit.links.length > 0) parts.push(hit.links.map((link) => link.name).join(", "));
  return `${parts.join(" → ")}  (score ${hit.score})`;
}

/** Render one project's whole map (`map show <project>`). */
export function formatProjectMap(map: ProjectDomainMap): string {
  const lines = [
    `ドメインマップ: ${map.project} (${map.records.length} 件, built ${map.builtAt})`,
  ];
  for (const note of map.notes) lines.push(`  note: ${note}`);
  for (const record of map.records) {
    lines.push(`  - [${record.kind}] ${record.name}`);
    if (record.coreDomain && record.coreDomain !== record.name) {
      lines.push(`      コアドメイン: ${record.coreDomain}`);
    }
    if (record.programDomains.length > 0) {
      lines.push(`      層: ${record.programDomains.join(", ")}`);
    }
    if (record.paths.length > 0) lines.push(`      パス: ${pathList(record.paths)}`);
    if (record.spec) lines.push(`      spec: ${record.spec}`);
    if (record.links.length > 0) {
      lines.push(`      関連: ${record.links.map((link) => `${link.name} (${link.via})`).join(", ")}`);
    }
  }
  return lines.join("\n");
}

function pathList(paths: string[]): string {
  const shown = paths.slice(0, MAX_PATHS).join(", ");
  return paths.length > MAX_PATHS ? `${shown} ほか${paths.length - MAX_PATHS}件` : shown;
}
