---
title: Anatomia entry-point trace graph
type: feature
service: anatomia
domain: analysis-core
status: planned
tags:
  - entry-point
  - reachability
  - call-graph
  - product-trace
  - viewer
x-anatomia:
  kind: entrypoint-trace-graph
---

# feature: エントリポイント追跡グラフ（解析木トラバーサ）

## 目的

解析木（Merkle-AST → call graph）を **プロダクトの入口 (entry point) から辿る**トラバーサを
第一級の解析として持ち、「この製品はどこから始まり、どこまで届いているか」を決定的なグラフ
として答える。

既存の到達解析は用途別に散在している:

- scene 導出（[scene-derivation.md](./scene-derivation.md)）— 画面ファイルの関数を起点にした
  `calls` 閉包。**画面**という 1 種類の入口に限る。
- 動的トレース（[dynamic-trace-and-phase.md](./dynamic-trace-and-phase.md)）— 実行観測。
  録画が無いプロジェクトでは使えない。
- `callers` / `callees` / `reachable` (graph query) — 1 記号起点のアドホック問い合わせ。

本仕様はこれらを統合し、**入口の列挙 → 入口ごとの到達木 → 製品全体の到達グラフ**を
fingerprint キー付き artifact として永続化する。ドメイン定義（ビジネス/プログラム、
[domain-dual-layer.md](./domain-dual-layer.md)）とは独立の軸であり、ドメイン割当を変更しない。
ドメインは到達グラフの**着色**（node の owner / belongs-to）として重ねるだけである。

## 用語

- **entry point（入口）**: プロダクトの外部から最初に制御が入る CodeSymbol。プロセス起動
  (`main` / bin script)、HTTP ルートハンドラ、CLI サブコマンド、イベント/メッセージハンドラ、
  タイマー/cron、テストランナー以外のフレームワーク lifecycle（Unity `Awake/Start/Update` 等）、
  画面 (screen) の描画関数。
- **entry class**: 入口の分類。`process` / `http-route` / `cli-command` / `event-handler` /
  `scheduled` / `framework-lifecycle` / `screen` / `explicit`（設定・注釈による明示）。
- **trace tree（到達木）**: 1 入口から `calls` 辺（既定）を BFS した閉包。各 node は
  `distance`（最短ホップ）と `via`（最短経路上の親、決定的タイブレーク）を持つ。
- **product graph（製品グラフ）**: 全 trace tree の和。node ごとに `reachedFrom: entryId[]` を
  持つ。どの入口からも届かない CodeSymbol は **unrooted** として列挙する（隠さない）。
- **frontier（追跡断絶点）**: 到達木の末端で、静的解決できず辺が落ちた call site
  （`UnresolvedCall`: `abstract-no-impl` / `external-type` / `unresolved-receiver` /
  `no-local-candidate`）。動的辺回復（[dynamic-edge-recovery.md](./dynamic-edge-recovery.md)）
  の join key と同一。

## 不変条件

1. **決定的**: LLM 無し・時刻無し。同一入力（解析 snapshot + 設定）→ byte 同一の artifact。
   node / edge / entry / diagnostics はすべてソート済み。
2. **code-authoritative**: 入口の検出結果は sync のたびに全置換する。手動 override は持たず、
   誤りの修正先は設定 (`.anatomia/entrypoints.json`)・code annotation・source code。
3. **全域性の表明**: 全 CodeSymbol は `reached`（1 つ以上の入口から到達）か `unrooted` の
   どちらかに分類される。unrooted は diagnostic として surface し、default で入口に
   押し込まない。
4. **frontier を隠さない**: 落ちた辺は到達木の葉に `frontier[]` として残し、件数と reason を
   集計に出す。「届かない」と「追えない」を同一視しない（[domain-discovery-workflow.md](./domain-discovery-workflow.md)
   の未解決呼び出しの扱いを踏襲）。
5. **ドメイン非侵襲**: 本機能はドメイン定義・owner edge・belongs-to edge を読むだけで書かない。
6. **既存 reachability の再利用**: 到達木の BFS は scene 導出のすべての `reachClosure` と
   同じ traversal 実装を共有する（別実装を増やさない）。

## 入口の検出（entry detectors）

検出器は `EntryPointSeed[]` を返し、canonical `EntryPointManifest` に正規化する。優先順は
**設定 → 注釈 → 言語/フレームワーク規約**。同一 CodeSymbol に複数検出器が当たった場合は
class を配列で保持し（例: `screen` かつ `framework-lifecycle`）、入口としては 1 つに畳む。

| 検出器 | 対象 | 判定材料 |
|---|---|---|
| `explicit-config` | 全言語 | `.anatomia/entrypoints.json`（下記）。`symbol` / `pathGlob` / `namePattern` |
| `explicit-annotation` | 全言語 | 定義直前コメントの `@anatomia-entry [class]` |
| `process-main` | TS/JS/C++/C# | `main` 関数、`package.json` の `bin` / `main` / `scripts` が指すファイルの top-level 実行、`bin/*.mjs` |
| `http-route` | TS/JS | `app.get/post/patch/delete/all(path, handler)` (Hono/Express 系)、Next file-route (`app/**/route.ts`, `pages/api/**`) — screens/detect の route table 検出を共有 |
| `cli-command` | TS/JS | subcommand dispatch（`case "verb":` / `switch (subcommand)` / commander/yargs 系の `.command()`）— Anatomia 自身の `src/adapters/cli.ts` が第一のテストケース |
| `event-handler` | TS/JS/C# | `.on("event", handler)` / `addEventListener` / Discord `client.on` / MCP `server.tool(...)` / C# `+=` イベント購読 |
| `scheduled` | TS/JS | `setInterval` / `cron.schedule` / Concordia timer delegation 登録 |
| `framework-lifecycle` | C# (Unity) | 既存 `frameworks/unity/lifecycle.ts` の MonoBehaviour lifecycle 一致（phase を保持） |
| `screen` | web/unity/native | 既存 screens/detect の ScreenNode（描画関数群を entry set とする） |

テストファイル（`*.test.*` / `__tests__/` / `tests/`）内の検出は既定で除外し、
`includeTests: true` で規約検出にも含められる。

### `.anatomia/entrypoints.json`

```json
{
  "includeTests": false,
  "include": [
    { "symbol": "src/adapters/cli.ts#runCli", "class": "cli-command" },
    { "pathGlob": "src/adapters/web/routes/**", "class": "http-route" },
    { "namePattern": "^handle[A-Z]\\w+$", "class": "event-handler" }
  ],
  "exclude": [ { "pathGlob": "**/*.test.ts" } ],
  "traversal": { "edgeKinds": ["calls"], "maxDepth": 64 }
}
```

- `includeTests` の既定は `false`。`true` のときだけテストファイルを規約検出の対象に戻す。
- `include` は検出器の結果に**追加**する（置換ではない）。`exclude` は最終 manifest から落とす。
- `traversal.edgeKinds` の既定は `["calls"]`。`depends` / `reads` / `writes` を足すとデータ流を
  含む広い到達になる（意味が変わるので既定にしない）。
- 設定が無いプロジェクトでも規約検出だけで動く（設定必須にしない）。

## トラバーサと product graph

1. 入口 manifest を確定する（stable ID = qualified symbol anchor。表示名・path は identity に
   しない。rename は anchor の同一性で追う）。
2. 各入口について `edgeKinds` の outgoing 辺を BFS。`distance` と `via`（親候補が複数なら
   anchor 昇順で決定）を記録。深さ上限 `maxDepth` 到達は diagnostic。
3. 各 node について `UnresolvedCall` を引き、`frontier[]`（`calleeName` / `receiverType` /
   `reason`）を付ける。
4. 全入口の和を取り `reachedFrom` を作る。到達しなかった CodeSymbol は `unrooted[]`。
5. 着色: node の owner（ビジネスドメイン、Gate B 承認済 edge）と belongs-to（プログラム
   ドメイン）を **参照のみ**で付与。入口ごとに `activatesDomains` を集計（scene の
   `activates Domain` と同型）。

### 出力（artifact）

`<generated>/entrypoint-graph.json`（fingerprint キー付き。web cache / Kuzu projection も
scene・program-domain と同型で持つ）:

```text
EntryPointGraph {
  schemaVersion, projectId, sourceRevision, definitionFingerprint,
  entries: [{ id, classes[], symbol{ anchor, name, path, line }, detector[], phase?,
              reached: number, maxDistance, activatesDomains{ business[], program[] },
              frontierCount }],
  nodes:   [{ anchor, name, path, reachedFrom: entryId[], distance: {entryId: n},
              via: {entryId: anchor}, owner?, programDomain?, frontier[] }],
  edges:   [{ from, to, kind, onTreeOf: entryId[] }],   // 到達木上の辺のみ
  unrooted: [{ anchor, name, path }],
  diagnostics: [{ kind: "max-depth" | "no-entry-detected" | "config-invalid", ... }]
}
```

`entries` が空（検出ゼロ・設定なし）のプロジェクトは `no-entry-detected` を出し、全 symbol を
`unrooted` にする（黙って空にしない）。

## インタフェース

- **CLI**: `anatomia entrypoints --project <id> [--json] [--entry <anchor|name>] [--unrooted]
  [--frontier]`。`--entry` は 1 入口の到達木を path 付きで表示、`--unrooted` / `--frontier` は
  それぞれの一覧。exit code は常に 0（gate ではない）。
- **HTTP**: `GET /api/projects/:id/entrypoint-graph`（prepared cache から読む。開いた瞬間の
  再解析なし）、`GET /api/projects/:id/entrypoint-graph/:entryId`（1 入口の到達木）。
- **export-graph**: `--mode entrypoints` で入口を根にした forest を静的 HTML に出す
  （既存 export-graph の描画を共有。unrooted は灰色クラスタ、frontier は破線末端）。
- **ビューア**: トップタブ [シーン] [ドメイン] に **[入口]** を追加
  （[viewer-scene-domain-tabs.md](./viewer-scene-domain-tabs.md) の構成を踏襲）。入口一覧
  （class / 到達数 / frontier 数）→ 選択で到達木 + 着色ドメイン、シーンタブ・ドメインタブへ
  stable ID で deep link。
- **ContextBundle**: `where` / `context` の結果に `nearestEntries[]`（着地点 anchor に最短で
  届く入口 ≤3）を追加する。結果形状が変わるため bundle cache version を上げて既存 cache を
  invalidate する。ハーネス supply（Castra `.claude/hooks/anatomia-supply.mjs`）はこれを
  「この変更はどの入口から効くか」として前置きできる。

## 既存機能との関係

- **scene**: `screen` 検出器は scene の entry set と同じ関数群を使う。scene 導出は
  本機能の到達木を再計算せず参照してよい（実装順は本機能が scene の traversal を再利用する
  形で先行し、scene 側の置き換えは別タスク）。
- **動的トレース**: 録画がある場合、観測済み辺で frontier を再確認できる
  （dynamic-edge-recovery）。本仕様では静的側だけを扱い、観測 overlay は scene 同様
  local overlay として後続で join する。
- **プログラムドメイン**: 到達木は layer 越境を可視化する材料になる（presentation 入口 →
  infrastructure 直結など）。判定・gate 化は本仕様の範囲外。
- **Revisor**: gate にしない。pr-review の advisory 情報として「変更 symbol に届く入口」を
  出すのは後続タスク。

## 関連

- [scene-derivation.md](./scene-derivation.md) — 画面起点 reachability（再利用元）
- [screen-composition.md](./screen-composition.md) — screen / route table 検出
- [dynamic-edge-recovery.md](./dynamic-edge-recovery.md) — frontier の join key
- [domain-dual-layer.md](./domain-dual-layer.md) — 着色に使う二層ドメイン
- [context-supply.md](./context-supply.md) — `nearestEntries` の載せ先
- [graph-export-and-panel.md](./graph-export-and-panel.md) — export-graph
