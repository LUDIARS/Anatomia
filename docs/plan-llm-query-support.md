# 改修計画: LLM 検索キャッシュサポーターとしての完成 (Codex 実装用)

> 発端: 2026-07-03 Fable による実装評価。解析基盤 (Merkle-AST / 5 ゲート verify /
> キャッシュ機構) は成熟しているが、**LLM がトークン節約のために引きたい読み取りクエリが
> 未公開**で、supply 側 (`where` / `context`) の production 配線がスタブ or 全部盛りのまま。
> 本計画はそのギャップを塞ぐ 5 タスク + 計測 1 タスク。

## ゴール

Fable / Claude Code が **対象リポを Grep + 全文 Read せずに** Anatomia 経由で
「シンボルの所在 → 呼び出し関係 → タスク関連文脈 (小さい束)」を引ける状態にする。
成功判定: Concordia 規模 (458 files / 4205 functions) で context バンドルが
**32KB 以下・決定的 (byte-identical)**、`where` が実ドメインに着地する。

## 共通ルール (全タスク)

- スタック: TypeScript / Node ESM。既存レイヤ構成 (`src/graph` / `src/supply` /
  `src/adapters` / `src/project` / `src/spec`) に従い、**新しいトップレベルレイヤを作らない**。
- SRP: 1 ファイル 1 責務。既存ファイルが肥大するなら同レイヤ内で分割。
- テスト: 各モジュール隣の `__tests__/*.test.ts` (vitest, hermetic — 実 FS/API 依存禁止。
  グラフは `src/graph/in-memory.ts` で組む)。
- 完了条件 (各タスク共通): `npm run typecheck` / `npm test` green → `npm run build`
  (**CLI/MCP は `dist/` をロードするので build 必須**) → 受入コマンドの実行結果を PR に貼る。
- ブランチ → PR → squash merge。**全タスクを 1 PR に集約**(LUDIARS 運用)。main 直 push 禁止。
- 新 CLI サブコマンド / MCP ツールを足したら README「AI への接続」と
  `docs/mcp-setup.md` のツール数 (現 7) を更新する。

## 前提知識 (実装済みで再利用するもの)

| 部品 | 場所 | 使い方 |
|---|---|---|
| グラフ問い合わせ interface | `src/graph/query.ts` `CodeGraphQuery` | `getNode` / `allNodes` / `neighbors` / `predecessors` / `fanCounts` / `reachable(id, {maxDepth, direction})` が既にある |
| 関数一覧 | `AnalysisContext.functions` (`FunctionNode[]`: name / signature / sourceRange / id=AnchorId) | シンボル索引の材料 |
| 着地点アルゴリズム | `src/supply/landing.ts` `resolveLanding(task, detector, layerRules, siblings)` | **実装済み。注入がスタブなだけ** |
| ドメイン検出結果 | `AnalysisContext.domains` (`implementors` に AnchorId 群) / `ctx.rules` | 実 detector の材料 |
| embedding リンカ | `src/spec/semantic.ts` `EmbeddingClient` / `findSemanticLinks` (cosine, 閾値 0.3) | 関連度フィルタの意味照合オプションに再利用 |
| 束の決定性 | `src/supply/bundle.ts` `assembleBundle` (安定ソート + dedup) / `bundleContentKey` | 変更後もこの経路を必ず通す |
| バンドルキャッシュ鍵 | `src/core.ts` `bundleCacheKey` | 新パラメータは**必ず鍵に畳み込む** |

スタブ注入の現場 (3 箇所、T-C で置換):
`src/core.ts` `buildContextBundle` 内 (`stubDetector` = 常に `["general"]`, `stubLayerRules`,
`stubSiblings`)、`src/adapters/mcp.ts` ~L138-140、`src/adapters/cli.ts` ~L479-481。
また `buildContextBundle` は exemplars を `ctx.functions.slice(0, 5)` (ソース順先頭 5 件) で
選んでおり、`impactRadius: []` 固定。

---

## T-A: 読み取りクエリ層 — `find` / `callers` / `callees` (最優先)

**目的**: 内部に既にある関数索引とコールグラフを LLM に公開する。トークン節約の主役。

### A-1 シンボル索引モジュール (新規)

`src/graph/symbol-lookup.ts` を新規作成:

```ts
export interface SymbolHit {
  name: string;
  signature: string;
  filePath: string;
  startLine: number;
  endLine: number;
  anchor: AnchorId | null;
  fanIn: number;   // graph.fanCounts(anchor, "calls")
  fanOut: number;
}
export interface SymbolLookupOptions {
  mode?: "exact" | "prefix" | "substring";  // default "exact"、hit 0 件なら自動で substring に fallback
  limit?: number;                            // default 20
}
export function buildSymbolIndex(functions: FunctionNode[]): Map<string, FunctionNode[]>;
export async function findSymbol(
  index: Map<string, FunctionNode[]>, graph: CodeGraphQuery,
  name: string, opts?: SymbolLookupOptions): Promise<SymbolHit[]>;
export async function callersOf(ctx, graph, nameOrAnchor: string, limit?): Promise<SymbolHit[]>;
export async function calleesOf(ctx, graph, nameOrAnchor: string, limit?): Promise<SymbolHit[]>;
```

- `callersOf` / `calleesOf` は入力がアンカー (16hex) ならそのまま、シンボル名なら
  `findSymbol` (exact) で解決してから `graph.predecessors(id, "calls")` /
  `graph.neighbors(id, "calls")`。同名多重定義は全件を対象にし、結果を anchor で dedup。
- 出力は**本文を含めない** (トークンリーン)。ソートは filePath → startLine の安定順。

### A-2 CLI サブコマンド

`src/adapters/cli.ts` のディスパッチ (現状 `verify | context | where | review | project |
export-graph | web | cache-stats | integral | domains | trace | screens`) に追加:

```sh
anatomia find <name> --project <p> [--mode substring] [--limit N] [--json]
anatomia callers <name|anchor> --project <p> [--json]
anatomia callees <name|anchor> --project <p> [--json]
```

`resolveContext` (cli.ts ~L431) で AnalysisContext を得る既存経路に乗せる (analyze キャッシュが効く)。
`--json` なしは 1 行 1 件 `name  filePath:startLine  fanIn/fanOut` のテキスト。

### A-3 MCP ツール

`src/adapters/mcp.ts` `_registerTools` に 3 ツール追加 (7 → 10):

- `anatomia.find` — input `{ name, project?, mode?, limit? }` → `{ hits: SymbolHit[] }`
- `anatomia.callers` — input `{ symbol, project?, limit? }` → `{ hits }`
- `anatomia.callees` — 同上

既存ツールと同じく zod スキーマ + `ProjectManager` 経由。description には
「Read/Grep の代わりに使うと関数所在と呼び出し関係をトークン消費なしで引ける」旨を書く
(LLM がツール選択する際の判断材料になる)。

### A-4 テストと受入

- `src/graph/__tests__/symbol-lookup.test.ts`: in-memory グラフ + 合成 FunctionNode で
  exact/substring/fallback、callers/callees、同名多重定義 dedup、limit。
- 受入コマンド:
  ```sh
  node bin/anatomia.mjs find handleChat --project concordia --json      # 所在が返る
  node bin/anatomia.mjs callers reportError --project concordia --json  # 呼び出し元一覧
  ```

---

## T-B: context バンドルのトークン予算 + タスク関連度フィルタ

**目的**: 現状 Concordia で 445KB (specClauses 519 節 320KB 無フィルタ + ソース順 exemplars)。
これを「タスクに関連する上位だけ・バイト予算内」に絞る。

### B-1 関連度ランキング (新規)

`src/supply/relevance.ts` を新規作成:

```ts
export interface RelevanceOptions {
  topClauses?: number;      // default 12
  topExemplars?: number;    // default 5
  embedder?: EmbeddingClient; // 任意注入。無ければ字面スコアのみ
}
export function rankSpecClauses(task: string, clauses: SpecClause[], opts?): SpecClause[];
export function rankExemplars(task: string, functions: FunctionNode[], opts?): FunctionNode[];
```

- 字面スコア (既定・決定的): task と clause の `heading + text` を小文字トークン化
  (`[a-z0-9_]+` と CJK 連続文字列)、重み = 共通トークン数 / task トークン数 + heading 一致は 2 倍。
  **同点は clause id の辞書順**で安定化 (束の決定性を壊さない)。
- exemplars も同方式で `name + signature` に対して。**0 件ヒット時は従来のソース順先頭 N に
  fallback** (空の手本を返さない)。
- embedder 注入時は `src/spec/semantic.ts` の cosine を再利用して字面スコアと平均。
  注入は adapters からのみ (core は決定的既定)。

### B-2 buildContextBundle への配線

`src/core.ts` `buildContextBundle`:

1. `specClauses: ctx.specClauses ?? []` → `rankSpecClauses(req.task, ...)` の上位 N。
2. `exemplars` の `slice(0, 5)` → `rankExemplars(req.task, ...)`。
3. 予算ガード: `assembleBundle` 後に JSON バイト数を測り、`maxBundleBytes`
   (BundleRequest に追加、default 32768) を超えたら specClauses を後ろから削って再組み。
4. **`bundleCacheKey` に topClauses / topExemplars / maxBundleBytes / ランキング関数の
   version 文字列 (`relevance-v1`) を畳み込む** (古い全部盛り束がキャッシュから返るのを防ぐ)。

### B-3 テストと受入

- `src/supply/__tests__/relevance.test.ts`: 関連節が上位に来る / 同点安定 / CJK タスク /
  0 ヒット fallback / 2 回実行 byte-identical。
- 受入:
  ```sh
  node bin/anatomia.mjs context --project concordia \
    --task "add exclusive lock to session claim release" > /tmp/ctx.json
  wc -c /tmp/ctx.json   # 32768 以下
  # 2 回実行して diff が空 (決定性)
  ```
  かつ specClauses に session 系の節が含まれること (現状は全 519 節)。

---

## T-C: `where` のスタブ解消 — 実 detector / siblings 配線

**目的**: `resolveLanding` は実装済みなのに、注入 3 箇所全部がスタブで
常に "Novel domain general (0.25)" しか返らない。実データを注入する。

### C-1 実 detector 群 (新規)

`src/supply/detectors.ts` を新規作成:

```ts
/** ctx.domains (実検出済み) からタスク字面マッチで担当ドメインを推定 */
export function contextDomainDetector(ctx: AnalysisContext): DomainDetector;
/** ドメイン → implementors (AnchorId) → FunctionNode を Sibling に変換 */
export function contextSiblingLookup(ctx: AnalysisContext): SiblingLookup;
/** ロード済み ontology にレイヤ定義があれば返す。無ければ layerFor: () => null */
export function contextLayerRules(ctx: AnalysisContext): LayerRules;
```

- detector: T-B の字面トークナイザを再利用し、task と
  `ドメイン名 + implementor 関数名群 (+ ドメインカード summary があれば)` を照合。
  スコア上位 (閾値以上) のドメイン名配列を返す。**閾値未満は `[]` を返す**
  ("general" に潰さない — novel 提案は resolveLanding 側の責務)。
- siblings: `ctx.domains[].implementors` の AnchorId を `ctx.functions` から引いて
  `Sibling { anchor, filePath, layer }` に。layer は不明なら null。

### C-2 3 箇所の置換

- `src/core.ts` `buildContextBundle`: `stubDetector/stubLayerRules/stubSiblings` を
  `contextDomainDetector(ctx)` 等に置換 (スタブ定義ごと削除)。
- `src/adapters/mcp.ts` ~L138-140 / `src/adapters/cli.ts` ~L479-481: 同様。
  3 箇所が同じ組み立てになるので `src/supply/detectors.ts` に
  `landingInjections(ctx)` ヘルパを 1 つ用意して共有してよい。

### C-3 impactRadius の配線

`buildContextBundle` の `impactRadius: []` を、着地点が見つかった場合に
`graph.reachable(anchor, { maxDepth: 2, direction: "both", kinds: ["calls"] })` の
AnchorId 列 (安定ソート・上限 50) に置換。着地点なしなら従来通り `[]`。

### C-4 テストと受入

- `src/supply/__tests__/detectors.test.ts`: 合成 ctx (domains 2 個 + implementors) で
  detector がタスクに応じて正しいドメインを返す / 閾値未満で `[]` /
  siblings が anchor→filePath を引けること。
- 受入:
  ```sh
  node bin/anatomia.mjs where --project concordia \
    --task "add exclusive lock to session claim and release"
  ```
  `domain` が `session-coordination` (等の実ドメイン)、`anchor` が非 null、
  `confidence >= 0.5` になること。現状値 (general / null / 0.25) からの改善を PR に貼る。

> 注: Concordia は retune 未実行でも analyze 時のビルトイン検出で `existingDomains` に
> 9 ドメイン出ている (実測)。detector はまず ctx.domains ベースで動かし、retune 生成
> ontology / Thaleia 突合結果の取り込みは本計画のスコープ外 (拡張フックだけ意識する)。

---

## T-D: プロジェクトレジストリの cwd 非依存化

**目的**: 現状 `src/project/store.ts` `resolveHome` が
`explicit > env ANATOMIA_HOME > <cwd>/.anatomia` のため、**対象リポの cwd から
`verify --project` を叩くと "unknown project" で落ちる** (実測済み。verify は対象リポで
`git diff` を取るため、この制約は運用上致命的)。

### D-1 解決順の変更

`resolveHome` を次の順に:

1. explicit 引数
2. env `ANATOMIA_HOME`
3. `<cwd>/.anatomia` — **`projects.json` が実在する場合のみ** (後方互換)
4. `os.homedir()/.anatomia` (新既定。無ければ作る)

- 3 の「実在チェック」が肝: 対象リポに `.anatomia/` が無ければ 4 に落ち、
  どの cwd からでも同じレジストリを見る。
- 既存データ移行: README に「`E:/Document/Ars/Anatomia/.anatomia` を使い続ける場合は
  `ANATOMIA_HOME` を設定するか、`~/.anatomia` へ移動」と明記。
  `anatomia-analyze` スキル (`E:/Document/Ars/.claude/skills/anatomia-analyze/SKILL.md`) の
  cwd 注意書きも更新対象。

### D-2 テストと受入

- `src/project/__tests__/store.test.ts` に解決順のケース追加 (tmpdir で 3/4 の分岐)。
- 受入:
  ```sh
  cd E:/Document/Ars/Concordia && git diff HEAD~1 HEAD | \
    node E:/Document/Ars/Anatomia/bin/anatomia.mjs verify --project concordia --json
  ```
  が unknown project にならず verdict を返すこと。

---

## T-E: verify のパス系ルールをファイル毎に評価

**目的**: 現状、複数ファイル diff は
`[anatomia/verify] diff touches 11 files; path-based rules are evaluated against the first`
と警告して先頭ファイルにしか適用されない。ゲートの実効性を削っている。

### E-1 実装

- `src/core.ts` `buildVerdict` (~L552) の diff 処理を、diff をファイルセクション単位に
  分割してループする形に変更。パススコープを持つルール評価をファイル毎に行い、
  ゲート結果は**全ファイルの union** (fail が 1 つでもあれば fail、anchors は結合 + dedup)。
- 言語判定 (`langForDiff`) もファイル毎に。パース不能ファイルは従来通り skip。
- 上記警告メッセージと `--file` 回避策の案内を削除。

### E-2 テストと受入

- 既存 verify テスト群に「2 ファイル diff で 2 ファイル目だけがパス系ルール違反 → fail」
  のケースを追加。
- 受入: 上記合成 diff で 1 ファイル目のみ評価なら pass になってしまうことの逆転を確認。

---

## T-F (任意・実装後の計測): トークン節約の実数取得

コード変更ではなく運用タスク。T-A〜T-D 完了後:

1. `ANATOMIA_HOME=~/.anatomia ANATOMIA_CACHE_DIR=~/.anatomia/llm-cache ANATOMIA_CACHE_LOG=~/.anatomia/logs/cache.jsonl` で MCP を立てる。
2. Fable / Claude Code の実セッションで「find/callers → context → verify」を 1 タスク分回し、
   同じタスクを Anatomia なし (Grep + Read) でも実施。双方の入力トークンを比較。
3. `node bin/anatomia.mjs cache-stats --log ~/.anatomia/logs/cache.jsonl` で hit 率を採取し、
   `docs/cache-measurement.md` に実測値の節を追記する。
   (現状の transcript は全て `llmCalls=0 / tokensSaved=0` で節約実績が未計測)

---

## 実装順序と依存

```
T-A (独立・最優先) ──────────────┐
T-D (独立・小)      ──────────────┤→ T-F 計測
T-C (detectors) → T-B (relevance が T-C の字面トークナイザを共有) ┘
T-E (独立)
```

- T-B と T-C は両方 `buildContextBundle` を触るので**この順で直列に** (競合回避)。
  字面トークナイザは `src/supply/relevance.ts` に置き、detectors から import する
  (逆依存にしない)。
- 全タスク 1 PR 集約。コミットはタスク単位で分ける。
