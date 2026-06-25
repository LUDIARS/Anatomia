/**
 * src/adapters/web/routes/relay.ts — Praeforma(Thaleia) リレー受け口。
 *
 * Route:
 *   POST /relay/anatomia   { project?, target?, requirements?, query, repo? } -> { nodes, edges, summary }
 *
 * WHY: Praeforma(Pf, 仕様↔実装連携ツール)の「要件定義モード」が、 ドメイン/シーンの要件束に
 * 対して「関連処理グラフ」を引くための受け口。 Pf × Anatomia の連携は MUSA の女神 **Thaleia**
 * (企画↔実装トレーサビリティ) にあたり、 Pf を主体とする暫定リレー契約を Anatomia 側がここで
 * 実装する。 Pf は Anatomia CLI を直叩きせず、 必ずこの HTTP 経由で呼ぶ。
 *
 * 契約は Pf が主体 (spec: Praeforma/spec/studio.md「MUSA リレー暫定契約」)。 path は Pf が
 * 構築する `${PRAEFORMA_MUSA_URL}/relay/anatomia` に合わせ、 Anatomia 既存の `/api/*` ではなく
 * `/relay/anatomia` に置く (外部契約エンドポイント)。
 *
 * SRP: HTTP routing + Pf 契約への型マッピングのみ。 解析は core.ts (buildContextBundle) と
 *      ctx.graph に委ねる。 LLM は不要 (ドメインは analyze 時に検出済)。
 */

import type { Hono } from "hono";
import { analyze, buildContextBundle } from "../../../core.js";
import type { AnalysisContext } from "../../../core.js";
import type { WebContextSource } from "../context.js";
import type { AnchorId, CodeNode, Edge, NodeKind, EdgeKind } from "../../../types.js";

/** 1 リレーで返すノード上限 (グラフ肥大の防止)。 */
const MAX_NODES = 60;

// ── Pf 契約の型 (Praeforma/server/src/lib/musa-relay.ts と対) ──────────────────

interface RelayRequirement {
  code?: string;
  title?: string;
  description?: string | null;
  priority?: string;
  category?: string;
  acceptance?: string[];
}

interface RelayRequest {
  project?: string;
  target?: { kind?: string; id?: string; name?: string; description?: string | null };
  requirements?: RelayRequirement[];
  query?: string;
  repo?: string;
}

/** Pf 側 GraphNodeType: 'symbol'|'file'|'domain'|'spec'|'external'。 */
type PfNodeType = "symbol" | "file" | "domain" | "spec" | "external";
/** Pf 側 GraphRelation: 'calls'|'depends'|'implements'|'related'。 */
type PfRelation = "calls" | "depends" | "implements" | "related";

interface RelayNode {
  key: string;
  label: string;
  type: PfNodeType;
  anatomia_ref: { path: string; line: number; domain?: string; kind: NodeKind };
}
interface RelayEdge {
  from: string;
  to: string;
  relation: PfRelation;
}
interface RelayResponse {
  nodes: RelayNode[];
  edges: RelayEdge[];
  summary: string;
}

// ── 型マッピング (Anatomia → Pf) ──────────────────────────────────────────────

function nodeKindToPfType(kind: NodeKind): PfNodeType {
  return kind === "file" ? "file" : "symbol";
}

function edgeKindToPfRelation(kind: EdgeKind): PfRelation {
  switch (kind) {
    case "calls":
      return "calls";
    case "implements":
    case "overrides":
      return "implements";
    case "depends":
    case "reads":
    case "writes":
    case "includes":
      return "depends";
    default:
      return "related";
  }
}

/** anchor → 所属ドメイン名 (最初に見つかった 1 つ)。 */
function buildAnchorDomainMap(ctx: AnalysisContext): Map<AnchorId, string> {
  const map = new Map<AnchorId, string>();
  for (const d of ctx.domains ?? []) {
    for (const a of d.implementors) {
      if (!map.has(a)) map.set(a, d.domain);
    }
  }
  return map;
}

/**
 * 要件束に対して「関連処理」の anchor 集合を決める。
 * 着地点 + 影響半径 + 手本 + (要件が指す既存ドメインの実装関数) を統合し、 上限で打切る。
 */
function selectAnchors(
  bundle: Awaited<ReturnType<typeof buildContextBundle>>,
  ctx: AnalysisContext,
): AnchorId[] {
  const seen = new Set<AnchorId>();
  const push = (a: AnchorId | null | undefined): void => {
    if (a && !seen.has(a)) seen.add(a);
  };

  push(bundle.landingAnchor);
  for (const a of bundle.impactRadius) push(a);
  for (const ex of bundle.exemplars) push(ex.id);

  // existingDomains に挙がったドメインの実装関数も種に含める (要件 ↔ 既存実装の橋渡し)。
  if (bundle.existingDomains.length > 0) {
    const wanted = new Set(bundle.existingDomains);
    for (const d of ctx.domains ?? []) {
      if (!wanted.has(d.domain)) continue;
      for (const a of d.implementors) push(a);
    }
  }
  return Array.from(seen).slice(0, MAX_NODES);
}

// ── Route ─────────────────────────────────────────────────────────────────────

/** Pf(Thaleia) リレー受け口を `app` にマウントする。 */
export function mountRelayRoutes(app: Hono, source: WebContextSource): void {
  app.post("/relay/anatomia", async (c) => {
    let body: RelayRequest;
    try {
      body = (await c.req.json()) as RelayRequest;
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) return c.json({ error: "missing 'query' (non-empty string)" }, 400);

    // 1. プロジェクト解決: 登録済 Anatomia project 優先、 無ければ repo path を直 analyze。
    let ctx: AnalysisContext;
    try {
      ctx = await source.resolve(body.project);
    } catch {
      if (typeof body.repo === "string" && body.repo.trim()) {
        try {
          ctx = await analyze(body.repo, { quiet: true });
        } catch (e) {
          return c.json({ error: `analyze failed for repo: ${String(e)}` }, 502);
        }
      } else {
        return c.json(
          { error: `no such anatomia project "${body.project ?? ""}" and no 'repo' given` },
          404,
        );
      }
    }

    // 2. task 文字列: query + 要件タイトル + 対象名 を結合してドメイン検出/着地に効かせる。
    const reqTitles = (body.requirements ?? [])
      .map((r) => (typeof r.title === "string" ? r.title : ""))
      .filter(Boolean);
    const targetName = typeof body.target?.name === "string" ? body.target.name : "";
    const task = [query, targetName, ...reqTitles].filter(Boolean).join(". ");

    // 3. ContextBundle (決定的、 LLM 不要)。
    const bundle = await buildContextBundle(ctx, { task });

    // 4. ノード集合 → RelayNode。
    const anchors = selectAnchors(bundle, ctx);
    const anchorSet = new Set(anchors);
    const domainOf = buildAnchorDomainMap(ctx);
    const nodes: RelayNode[] = [];
    for (const a of anchors) {
      const n: CodeNode | undefined = await ctx.graph.getNode(a);
      if (!n) continue;
      const domain = domainOf.get(a);
      nodes.push({
        key: n.id,
        label: n.name,
        type: nodeKindToPfType(n.kind),
        anatomia_ref: {
          path: n.sourceRange.filePath,
          line: n.sourceRange.start.line,
          ...(domain ? { domain } : {}),
          kind: n.kind,
        },
      });
    }

    // 5. 誘導部分グラフ (両端が集合内のエッジのみ) → RelayEdge。
    const edgeSeen = new Set<string>();
    const edges: RelayEdge[] = [];
    for (const a of anchors) {
      const out: Edge[] = await ctx.graph.edgesFrom(a);
      for (const e of out) {
        if (!anchorSet.has(e.to)) continue;
        const relation = edgeKindToPfRelation(e.kind);
        const k = `${e.from}|${e.to}|${relation}`;
        if (edgeSeen.has(k)) continue;
        edgeSeen.add(k);
        edges.push({ from: e.from, to: e.to, relation });
      }
    }

    // 6. summary (Pf は text 列に保存・表示するので 1 文字列)。
    const landing = bundle.landingAnchor ?? "novel(新規着地)";
    const doms = bundle.existingDomains.length > 0 ? bundle.existingDomains.join(", ") : "なし";
    const summary =
      `関連処理 ${nodes.length} nodes / ${edges.length} edges。 ` +
      `既存ドメイン: ${doms}。 着地: ${landing}。 ` +
      `適用ルール ${bundle.applicableRules.length} / 関連仕様 ${bundle.specClauses.length}。`;

    const res: RelayResponse = { nodes, edges, summary };
    return c.json(res);
  });
}
