# spec ↔ コード対応レビュー

> `DESIGN.md`（設計正本）/ `TASKS.md`（タスク T01–T49）/ `spec/usage/analysis-procedure.md`（手順）/
> `README.md` の記述と、実際の `src/` 実装が対応しているかをレビューした結果。
> レビュー日: 2026-06-18。

## 結論

**48 / 49 タスクがフル実装・テスト済み。残り 1 件は DESIGN §13 に明記された意図的な保留**
（実ゲームのトレース録画経路の配線）。仕様材料（DESIGN / TASKS / README / analysis-procedure）の
記述と実装は整合しており、設計が「将来作業」と明記したもの以外に齟齬は見つからなかった。

- TypeScript ソース: 178 ファイル（約 10,805 行）
- テストファイル: 74（全モジュールを網羅）
- ゲート G0–G9 はフル配線、G10（局面学習）はライブラリ API としてフル実装
- MCP ツール: **7**（README の主張と一致）
- CLI サブコマンド: **7**（`verify` / `context` / `where` / `project` / `export-graph` / `web` / `cache-stats`）

---

## ゲート別 対応表（タスク → 状態 → 実装根拠）

### G0 — scaffold / 横断（T01–T02）

| タスク | 状態 | 実装 / 根拠 |
|---|---|---|
| T01 プロジェクト scaffold | ✅ | `package.json` / `tsconfig.json` / vitest / `src/plugins/loader.ts` |
| T02 共通型 + Anchor ID 型 | ✅ | `src/types.ts` |

### G1 — 静的層・コンテンツアドレス DAG（T03–T10）

| タスク | 状態 | 実装 / 根拠 |
|---|---|---|
| T03 C++/C# パーサ wrapper | ✅ | `src/dag/parser.ts`（web-tree-sitter, cpp/c_sharp/ts/tsx） |
| T04 関数抽出 | ✅ | `src/dag/extract.ts` |
| T05 関数正規化（α 正規化） | ✅ | `src/dag/normalize.ts` |
| T06 関数ハッシュ（Anchor ID） | ✅ | `src/dag/hash.ts` |
| T07 ファイル/モジュール Merkle DAG | ✅ | `src/dag/merkle.ts` |
| T08 差分判定 | ✅ | `src/dag/diff.ts` |
| T09 インクリメンタル再索引 | ✅ | `src/dag/incremental.ts` |
| T10 命中率計測ハーネス | ✅ | `src/dag/measure.ts` / `scripts/measure.mjs` |

### G2 — グラフ + KG（T11–T13）

| タスク | 状態 | 実装 / 根拠 |
|---|---|---|
| T11 インメモリ・コードグラフ | ✅ | `src/graph/in-memory.ts` / `src/graph/build.ts` |
| T12 query 層 interface | ✅ | `src/graph/query.ts`（in-memory と Kuzu 両実装） |
| T13 Kuzu KG 射影 | ✅ | `src/graph/kuzu.ts` |

### G3 — ドメイン + ルール（T14–T20）

| タスク | 状態 | 実装 / 根拠 |
|---|---|---|
| T14 ルール述語エンジン | ✅ | `src/domains/engine.ts` / `src/domains/predicate.ts` |
| T15 preset ルールカタログ | ✅ | `src/domains/presets.ts` |
| T16 テンプレートルール（by-example） | ✅ | `src/domains/template.ts` / `src/domains/matcher.ts` |
| T17 ルール逆生成（マイニング） | ✅ | `src/domains/mining.ts` |
| T18 ドメインオントロジー plugin loader | ✅ | `src/domains/ontology.ts` |
| T19 ドメイン検出 | ✅ | `src/domains/detect.ts` |
| T20 ドメインカード生成（content-key cache） | ✅ | `src/domains/card.ts` |

### G4 — コード ↔ 仕様（T21–T25）

| タスク | 状態 | 実装 / 根拠 |
|---|---|---|
| T21 仕様パーサ | ✅ | `src/spec/parse.ts` |
| T22 明示リンカ | ✅ | `src/spec/explicit.ts` |
| T23 構造リンカ | ✅ | `src/spec/structural.ts` |
| T24 意味リンカ | ✅ | `src/spec/semantic.ts` |
| T25 信頼度/根拠付きエッジ + 硬化ループ | ✅ | `src/spec/harden.ts` / `src/spec/link-store.ts` |

### G5 — supply / verify（重心、T26–T29）

| タスク | 状態 | 実装 / 根拠 |
|---|---|---|
| T26 複雑度メトリクス + 相対閾値 | ✅ | `src/supply/metrics.ts` / `src/supply/thresholds.ts` |
| T27 着地点決定 | ✅ | `src/supply/landing.ts` |
| T28 supply 束組み（決定的） | ✅ | `src/supply/bundle.ts` |
| T29 verify（5 ゲート） | ✅ | `src/supply/verify.ts` + `src/supply/gates/*.ts` |

### G6 — アダプタ（T30–T32）

| タスク | 状態 | 実装 / 根拠 |
|---|---|---|
| T30 MCP アダプタ | ✅ | `src/adapters/mcp.ts`（4 core + 3 project = 7 tool） |
| T31 CLI ゲート | ✅ | `src/adapters/cli.ts`（block 違反で exit 1） |
| T32 Web viz アダプタ（静的） | ✅ | `src/adapters/web/server.ts` + `routes/*` |

### G7 — 動的トレース（T33–T39）

| タスク | 状態 | 実装 / 根拠 |
|---|---|---|
| T33 静的ループ骨格抽出 | ✅ | `src/dynamic/skeleton.ts` |
| T34 マーカー自動注入（C++） | ✅ | `src/dynamic/inject-cpp.ts` |
| T35 マーカー自動注入（C#） | ✅ | `src/dynamic/inject-csharp.ts` |
| T36 フレーム同期スコープ計測ランタイム | ✅ | `src/dynamic/protocol.ts` / `src/dynamic/ringbuffer.ts` |
| T37 trace 配信 transport | ✅ | `src/dynamic/transport.ts` |
| T38 zone ↔ カード 縫合 | ✅ | `src/dynamic/stitch.ts` |
| T39 計測ビルド戦略 | ✅ | `src/dynamic/build-strategy.ts` |

### G8 — 動的可視化（T40–T42）

| タスク | 状態 | 実装 / 根拠 |
|---|---|---|
| T40 フレーム×ドメインタイムライン | ✅ | `src/dynamic/viz/timeline.ts`（`GET /api/trace/timeline`） |
| T41 光るグラフ | ✅ | `src/dynamic/viz/active.ts`（`GET /api/trace/active`） |
| T42 You are here カーソル | ✅ | `src/dynamic/viz/where.ts`（`GET /api/trace/where`） |

### G9 — 配線 + 結合テスト（T43–T44）

| タスク | 状態 | 実装 / 根拠 |
|---|---|---|
| T43 e2e 配線 | ✅ | `src/core.ts` の `analyze()` パイプライン |
| T44 結合テスト + 計測レポート | ✅ | `src/__tests__/e2e.test.ts` / `scripts/measure.mjs` |

### G10 — 局面の学習（T45–T49）

| タスク | 状態 | 実装 / 根拠 |
|---|---|---|
| T45 局面署名 | ✅ | `src/dynamic/phase/signature.ts` |
| T46 局面発見 | ✅ | `src/dynamic/phase/discover.ts` |
| T47 FSM induction | ✅ | `src/dynamic/phase/fsm.ts` |
| T48 局面ラベル | ✅ | `src/dynamic/phase/label.ts` |
| T49 局面分類（オンライン） | ✅ | `src/dynamic/phase/classify.ts` |
| 残: 実ゲーム録画経路の配線 | ⏸ 保留 | `src/dynamic/viz/trace-source.ts`（`RecordedTraceSource` は存在。実ゲーム runtime → ringbuffer → source の配線は未実装。DESIGN §13 / analysis-procedure §6 に明記） |

---

## 主張の検証（README / 手順書の記述 vs 実装）

| 主張 | 検証結果 |
|---|---|
| README「MCP 7 ツールを公開」 | ✅ 正確。`anatomia.context/.verify/.where/.impact`（4）+ `.projects.{list,add,analyze}`（3）= 7 |
| README / 手順 §2「CLI 7 サブコマンド」 | ✅ 正確。`verify` は block ゲート違反で exit 1 |
| 手順 §6「動的層は現状ライブラリ API のみ（CLI 未配線）」 | ✅ 正確。phase 層はライブラリ API として実装済、実ゲーム録画配線は未実装 |
| TASKS §5.5 / DESIGN §13「局面学習は実装済（G10）」 | ✅ 正確。T45–T49 すべて実装・テスト済 |
| README「キャッシュ backend 優先度 = Redis > File > memory」 | ✅ 正確。`src/cache/resolve.ts` で確認 |
| プロバイダ未設定時の hermetic fallback | ✅ 正確。LLM→stub / embedder→hash-embedder（`src/providers/index.ts`） |

---

## 残課題（DESIGN §13 の保留事項のみ）

- **実トレース録画経路の配線**: 局面学習層（T45–T49）は `RecordedTraceSource` を入力に動作する形で
  実装済だが、実ゲーム（KS/AC）のマーカー注入 → ringbuffer → `RecordedTraceSource` 供給の配線は別タスク。
  これは設計上「将来作業」として明記されており、齟齬ではない。
</content>
</invoke>
