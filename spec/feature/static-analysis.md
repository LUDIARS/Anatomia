# feature: 静的解析（解剖 → Merkle DAG → コードグラフ）

## 目的

リポジトリのソースを「機構」へ解剖し、決定的にハッシュ化した Merkle DAG とその上の
コードグラフ（KG）を組む。これが Anatomia の全機能（ドメイン検出 / spec linkage / verify /
context 供給）の土台になる。

## 振る舞い（入力 → 処理 → 出力）

入口は `analyze(repoPath, options?)`（`src/core.ts`）。`AnalysisContext` を返す。
パイプライン（DESIGN の G1→G5）：

```
.cpp/.h/.cs/.ts/.tsx を再帰収集（node_modules / dist / .git / *.d.ts は除外）
  → parse（tree-sitter, WASM はグローバルキャッシュ）
  → extractFunctions（関数抽出 + enclosingType / params）/ extractTypeDecls（class/基底）
  → normalize（body 正規化）
  → assignAnchorId（Anchor ID 付与 = body 正規化 + signature のハッシュ）
  → buildFileNode / FileNode Merkle（→ data/merkle-dag.md）
  → extractEdgeInfo → buildGraph → InMemoryCodeGraph（KG）
  → 【G3】detectDomains（→ feature/domain-detection.md）
  → 【G4】spec linking（→ feature/spec-linkage.md）
```

`AnalysisContext` の主フィールド：`repoPath / graph / files / functions /
specClauses? / links? / domains? / skipped?`。

## 呼び出し辺の解決（calls edge resolution）

Anatomia は呼び出しを **名前** で解決する（型推論器は持たない）。同名メソッドが
複数層に再定義される汎用 virtual アクセサ（`alive()` / `position()` / `tick()`）は、
素朴に名前一致させると全定義へ辺を張り、偽の「spine を上に呼ぶ」違反を量産する。
そこで解決は次の優先順で行う（`src/graph/build.ts` + `src/graph/type-resolve.ts`）：

1. **型認識（type-aware）** — receiver（`recv.method()` の `recv`）の静的型が決まる場合：
   receiver の型を **パラメータ / ローカル変数 / range-for ループ変数 / `this`**、
   無ければ **囲みクラスのデータメンバ**（`hit_.count()`）から求める。`for (auto* r : xs)`
   の loop 変数は、コンテナ（`std::vector<T*>`）の **要素型 T** から型付けする。
   囲みクラスは in-class 定義だけでなく **`Class::method` の out-of-line 定義のスコープ**からも取る。
   - 型 T が **解析対象の既知クラス**なら、`method` を **T とその基底クラス階層** に限定して解決。
     階層に本体が無い場合（純粋仮想 interface 越し＝呼び出し側の層が所有する抽象への依存逆転）は、
     全 override へ fan-out せず **辺を落とす**（「combat が `IDamageReceiver&` 越しに `alive()`」型の根治）。
   - 型 T が決まったが **リポ外のクラス**（`std::unordered_set` 等）なら外部メソッドなので
     **辺を落とす**（同名のリポ関数への locality 誤接続＝`hit_.count` → 無関係な `count()` を防ぐ）。
2. **locality** — 非修飾呼び出し、または receiver の型が決められないとき：同一ファイル →
   同一ディレクトリの候補を優先する（`localityResolve`）。

トレードオフ（locality と同じ思想）：型認識で辺を落とすと、真の virtual dispatch 辺が
コールグラフから欠ける。建築リンタは「偽陽性を減らす（信頼）」を「コールグラフの網羅」より
優先するため許容する。

**限界**：receiver は 素の変数 / range-for ループ変数 / `this` / 囲みクラスのメンバのみ型付けする。
連鎖式（`a.b.method()`）・呼び出し結果（`auto& x = f(); x.m()`）は型付けしない（→ locality）。
型/フィールドは本体ハッシュには畳み込まない（`TypeDecl` は Merkle 非対象）。

## 言語判定

拡張子マップ（`langFor`）：`.cs → c_sharp`、`.tsx → tsx`、`.ts → typescript`、
それ以外（`.cpp / .h`）→ `cpp`。

## 決定性 / 耐障害性

- **Anchor ID** は意味が同じなら同一。これがキャッシュ命中（増分解析・LLM 蒸留）の土台。
- パース/抽出/正規化に失敗したファイルは **crash せず skip** し、理由付きで
  `AnalysisContext.skipped[]` に記録する（解析全体は止まらない）。
- ドメイン検出・spec linking の失敗も握りつぶし、その層が欠けた ctx を返す。

## 出力経路

- CLI `context` / `where` / `export-graph` / `verify`（→ interface/cli.md）
- MCP 7 ツール（→ interface/mcp.md）
- web サーバの解析系 API（→ interface/web.md）

## 関連

- データ: [data/merkle-dag.md](../data/merkle-dag.md)、[data/project-cache.md](../data/project-cache.md)
- 影響半径クエリ: `getImpactRadius(ctx, anchor)` = グラフの BFS 到達集合（MCP `anatomia.impact`）。
