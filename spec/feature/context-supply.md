# feature: context 供給（ContextBundle / landing / impact）

## 目的

AI がコードを書く**前**に、決定的な文脈束を渡して「クリーンに着地」させる。supply→verify
ループの「生成前」側。

## 振る舞い

`buildContextBundle(ctx, { task })`（`src/core.ts`）が `ContextBundle` を組む：

- **着地点（landing）**: `resolveLanding`（`src/supply/landing.ts`）でタスクの着地点
  （domain × layer × siblings）を解決。CLI/MCP adapter では detector/layerRules/siblings は
  stub 注入で landing を返す。
- **手本（exemplars）**: context 内の id 付き関数を source 順で最大 5 件。
- **既存ドメイン**: implementors を持つ検出ドメイン名（重複回避材料、→ feature/domain-detection.md）。
- **仕様節**: `ctx.specClauses`（→ feature/spec-linkage.md）。

`assembleBundle`（`src/supply/bundle.ts`）が landingAnchors / rules / specClauses /
exemplars / impactRadius / existingDomains から bundle を組み立てる。

## 影響半径（impact）

`getImpactRadius(ctx, anchor)`（`src/core.ts`）= コードグラフの BFS 到達集合（outgoing edges）。
MCP `anatomia.impact` で公開。

## 着地点のみ（where）

`where` は landing 解決だけを返す軽量経路（CLI / MCP `anatomia.where`）。

## 出力経路

- CLI `context` / `where`（→ interface/cli.md）
- MCP `anatomia.context` / `anatomia.where` / `anatomia.impact`（→ interface/mcp.md）
- web `GET /api/context`（warm harness、→ interface/web.md）

## 関連

- 生成後の対: [feature/verify-gates.md](./verify-gates.md)
