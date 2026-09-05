/**
 * src/map/types.ts — Cross-project domain map: data contract (design §12.2).
 *
 * The domain map answers the question a coding task opens with: **which
 * product, which content, which core domain, which paths**. `plan` and `where`
 * already work INSIDE one analysed project; the map is the layer above them
 * that picks the project(s) in the first place, so a Japanese instruction like
 * 「トランポリンカウンターで〇〇」 resolves to Ludellus / `uni-jump-trampoline`
 * / `renderer/mr/games/uni-jump` before any repo is analysed.
 *
 * Every record is derived DETERMINISTICALLY from committed declarations
 * (`spec/domains/*.domain.json`, `spec/domains/content-sources.json`,
 * `.anatomia/layers.json`, spec Markdown). No LLM takes part, so the same
 * checkout always produces the same index and a search costs milliseconds.
 *
 * SRP: type definitions only. Building lives in sources.ts, ranking in
 * search.ts, bundling in bundle.ts.
 *
 * @spec 横断ドメインマップ検索
 */
// @implements SPEC-domain-map

/** Schema version of a persisted project map; bumped when the shape changes. */
export const DOMAIN_MAP_VERSION = "domain-map-v2";

/**
 * What an index entry IS.
 *
 * - `content`      a shipped thing a person can name (a game, a demo, a tool)
 * - `core-domain`  a declared business domain (`spec/domains/*.domain.json`)
 * - `program-domain` a declared architectural layer (`.anatomia/layers.json`)
 * - `spec`         a spec document with no content declaration behind it
 * - `scene`        a named scene/screen of a product
 * - `service`      a runnable service surface (HTTP route / loopback port)
 */
export type DomainMapKind =
  | "content"
  | "core-domain"
  | "program-domain"
  | "spec"
  | "scene"
  | "service";

/** A cross-project edge: "this record talks to that project". */
export interface DomainMapLink {
  /** Project id of the other side (registry id, or the lowercased name). */
  project: string;
  kind: "service" | "project";
  /** Human-readable name of the other side. */
  name: string;
  /** Why the edge exists: the matched HTTP route or project mention. */
  via: string;
}

/** One index entry (design §12.2). */
export interface DomainMapRecord {
  /** Project id the record belongs to. */
  project: string;
  kind: DomainMapKind;
  /** Display name, in the product's own language. */
  name: string;
  /** Normalised spelling variants that must match this record exactly. */
  aliases: string[];
  /** The core domain this record belongs to, when it has one. */
  coreDomain: string | null;
  /** Architectural layers the record's paths live in. */
  programDomains: string[];
  /** Repo-relative paths the record owns, most specific first. */
  paths: string[];
  /** Repo-relative spec document, when one describes this record. */
  spec: string | null;
  /** Cross-project links found in the record's own text. */
  links: DomainMapLink[];
  /**
   * Free text the record is searchable on (the declaration's description, the
   * spec H1's surrounding line). Kept out of `name` so display stays short.
   */
  description: string;
}

/** Every record of one project, plus the key that says when to rebuild it. */
export interface ProjectDomainMap {
  version: typeof DOMAIN_MAP_VERSION;
  project: string;
  /** ISO build time (metadata; not part of `sourceKey`). */
  builtAt: string;
  /**
   * Content key over the declaration files the map is derived from. A rebuild
   * is skipped while this is unchanged — the map's own change detection, in the
   * same spirit as the analysis cache's fingerprint.
   */
  sourceKey: string;
  /** Link-roster key; changes after Concordia outage/recovery or roster edits. */
  rosterKey: string;
  records: DomainMapRecord[];
  /** Why a source was skipped (missing declaration, unreadable file). */
  notes: string[];
}

/** One search hit: the record plus why it ranked where it did. */
export interface DomainMapHit extends DomainMapRecord {
  score: number;
  /** The query terms that matched, for the "why this hit" line. */
  matched: string[];
}
