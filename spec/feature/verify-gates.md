# feature: verify — 5 ゲート検証パイプライン

## 目的

AI が生成した diff を、その codebase の grain（ドメイン・ルール・仕様・結合・慣習）に
逆らっていないか **5 ゲート**で検証する。supply→verify ループの「生成後」側。

## 振る舞い

入口は `buildVerdict(ctx, diff, targetPath?, opts?)`（`src/core.ts`）。diff を言語判定して
正しい文法でパース → 変更関数を抽出 → Anchor ID 付与 → `verify(diffInput, gates)`
（`src/supply/verify.ts`）。

`buildDefaultGates`（`src/supply/verify.ts`）が並べる 5 ゲートと重大度：

| # | ゲート名 | 重大度 | 内容（実装） |
|---|---|---|---|
| 1 | `rule_conformance` | **block** | 適用ルール（global ∪ domain）の述語違反が変更集合に交差したら fail（`gates/rule_conformance.ts`） |
| 2 | `duplication` | **block** | 変更コードが既存ドメインカードに似すぎ（cosine ≥ 既定 0.85）=ドメイン再発明を flag（`gates/duplication.ts`、embedding はここだけ flag として使用） |
| 3 | `spec_linkage` | warn →（strict 時）block | 変更関数が spec 節にリンクしない孤児を flag（`gates/spec_linkage.ts`） |
| 4 | `coupling_delta` | warn | 変更関数の結合/共有状態 fan-in がリポ自身の上位パーセンタイルを超え、かつ base 比で増加したら flag（codebase 相対、`gates/coupling_delta.ts`） |
| 5 | `convention_drift` | warn | 命名 case 様式・共通 affix が兄弟コードから乖離したら flag（LLM 不使用・構造的、`gates/convention_drift.ts`） |

## Verdict（出力）

`verify()` は `Verdict { pass, gates: GateResult[], anchors, suggestion }` を返す。

- `pass` = **すべての block ゲートが pass**。warn ゲートの失敗は verdict を落とさず、
  per-gate 結果と `suggestion`（`[BLOCK …]` / `[warn …]` プレフィックス付き）に出る。
- CLI `verify` は block 失敗で **exit 1**（クリーンコード生成ループのゲート）。

## プロバイダ有無

- `opts.providers` あり: 実 embedder + LLM 蒸留カードで duplication が実際に再発明を flag。
  `opts.cardCache`（content-keyed）で繰り返し verify でも LLM をスキップ。
- なし: zero-vector mock embed + カード無し → duplication は pass（hermetic 既定。テスト/CLI 単発）。

## 入力経路

- CLI `verify`（stdin から diff、→ interface/cli.md）
- MCP `anatomia.verify`（→ interface/mcp.md）
- web `POST /api/verify`（warm harness、→ interface/web.md）

## 関連

- [feature/domain-detection.md](./domain-detection.md)、[feature/spec-linkage.md](./spec-linkage.md)
- [feature/context-supply.md](./context-supply.md)（生成前の対）
