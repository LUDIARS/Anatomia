# Anatomia — 実装タスクリスト (Sonnet 向け)

> 設計正本: `DESIGN.md`。方針: **フルセット・No-MVP** (`feedback_full_set_no_mvp` /
> スキル `full-set-implementation`)。MVP/最小縦切りは作らず、設計済み機能を全部実装 → 配線 → テスト。
> **実装 = Sonnet / 最終レビュー = Opus**。保留は局面学習 (DESIGN §5.5) のみ。

## 共通ルール (全タスク)

- スタック: **TypeScript / Node (ESM)**。パース = **web-tree-sitter (WASM, gyp 不要)** +
  `tree-sitter-cpp` / `tree-sitter-c-sharp`。KG = **Kuzu (node)**。MCP = `@modelcontextprotocol/sdk`。
  LLM = Anthropic SDK (蒸留)。束整形 = `@ludiars/llm-gateway` の `orderSegments`。テスト = **vitest**。
- **単一責任 (SRP)** 必須。1 タスク = 1 機能 = 1 責務。ファイル分割 (`RULE_CODE` / `coding-conventions`)。
- 各タスクに **単体テスト**を付ける。`query 層`等の境界は interface で抽象化 (storage 差し替え可)。
- Anchor ID は **正規化 Merkle ハッシュ** (T03-T05)。全層がこの ID で連結する。

---

## G0. scaffold / 横断

- **T01 プロジェクト scaffold** — TS/Node ESM パッケージ (`package.json` name `anatomia`, `tsconfig`,
  vitest, `src/` レイアウト, lint)。plugin loader の土台 (`ANATOMIA_PLUGIN_DIR`)。
  受入: `npm test` が空で green、build 通る。
- **T02 共通型 + Anchor ID 型** — `AnchorId`, `AstNode`, `FunctionNode`, `Segment`, `Edge`,
  `Confidence/Evidence` 等の中核型を 1 ファイルに。受入: 型のみ、循環 import なし。

## G1. 静的層 — コンテンツアドレス DAG

- **T03 C++/C# パーサ wrapper** — web-tree-sitter で source→AST (言語フロントエンド plugin 境界)。
  受入: .cpp/.h/.cs をパースし関数を含む AST を返す。言語追加が plugin で可能。
- **T04 関数抽出** — AST → 関数/メソッドノード列 (name, signature, body subtree, source range)。
  受入: ネスト・オーバーロード含め全関数を列挙。
- **T05 関数正規化** — 関数 body から意味無関係差を除去 (整形/コメントは AST で既消、ローカル変数
  **α 正規化** = 位置インデックス化)。公開シンボル/型/呼び先は保持。
  受入: 整形・コメント・ローカル名のみ違う 2 関数が同一正規化形。
- **T06 関数ハッシュ (= Anchor ID)** — 正規化関数 → 安定ハッシュ。**関数の追加/更新が無ければ同一**
  (DESIGN §4.2 確定)。受入: 同一正規化形→同一ハッシュ、body 変化→別ハッシュ、別関数→衝突なし。
- **T07 ファイル/モジュール Merkle DAG** — 関数ハッシュ集合 → ファイル/モジュールハッシュ (子→親)。
  受入: 関数追加/更新無し→同一ファイルハッシュ、1 関数変更→ファイルハッシュ変化 + その関数だけ差分。
- **T08 差分判定** — 2 版のファイル/木 → added/updated/unchanged 関数を hash 比較で出す。
  受入: 整形・rename→unchanged、body→updated、追加/削除を正しく分類。
- **T09 インクリメンタル再索引** — 変更ファイルだけ再パース→DAG 部分更新 (祖先ハッシュ伝播)。
  受入: 1 ファイル変更で全再構築せず、影響ノードだけ更新。
- **T10 命中率計測ハーネス** — テストコーパス (整形のみ/rename のみ/body 変更/add-remove/別物) で
  false-invalidation / false-collision 率を出す。受入: 数値レポート出力、目標域を明示。

## G2. グラフ + KG (Kuzu)

- **T11 インメモリ・コードグラフ** — 関数ノード (Anchor ID) + calls/depends/reads-writes エッジを AST から構築。
  受入: 呼び出し・依存を辺として持つ。循環 (再帰) を保持。
- **T12 query 層 interface** — グラフ問い合わせの抽象境界 (近傍/集計/述語)。in-memory と Kuzu 両実装を差せる。
  受入: interface 定義 + in-memory 実装で近傍・集計が引ける。
- **T13 Kuzu KG 射影** — DAG/グラフ → Kuzu materialized view (CodeUnit/SpecClause ノード + 辺)。
  DAG が真実、KG は再生成。受入: グラフを Kuzu に投影し traceability クエリ (「X を呼ぶ全関数」) が引ける。

## G3. 機構 + ルール

- **T14 ルール述語エンジン** — グラフ上の述語 (「`{A}`→`{B}` 呼び出しが空」等) を評価 → 違反列。
  受入: 述語を与えると違反箇所 (Anchor + 根拠) を返す。重大度 (block/warn) を持つ。
- **T15 preset ルールカタログ** — パラメータ付き preset を一通り (層依存方向/state アクセス経路/
  hot-path alloc 禁止/呼び出し禁止/結合上限/no-cycle 等) → 設定で述語化。受入: preset 選択+パラメータで述語生成。
- **T16 テンプレートルール (by-example)** — 禁止/推奨のコード片 (`$SKILL.mutate($STATE)` 等) を
  構造マッチ述語にコンパイル。正例・負例両対応。受入: コード片パターンが構造マッチして違反検出。
- **T17 ルール逆生成 (マイニング)** — 既存の良い実装を指して「これが満たすルール候補」を提案。
  受入: exemplar から述語候補を出す (信頼度付き)。
- **T18 機構オントロジー plugin loader** — `ANATOMIA_PLUGIN_DIR` から機構定義 (preset 配置 +
  template ルール + 手本/カードテンプレ) をロード。受入: plugin を置くと機構が増える。
- **T19 機構検出** — オントロジー (preset/template) で、ある機構を担う関数群を判定 (conformance)。
  受入: AdventureCube 等の 1 機構の実装関数群を抽出 (真偽+根拠)。
- **T20 機構カード生成** — 機構の関数群 + 仕様 → カード (何の機構か/ルール/主要アンカー/仕様参照/複雑度)
  を LLM 蒸留。**content-key (Merkle ハッシュ) でキャッシュ**。受入: 同一入力で再計算せずキャッシュ、変更時のみ再生成。

## G4. コード ↔ 仕様 (DESIGN §4.5)

- **T21 仕様パーサ** — `spec/*.md` / `DESIGN.md` → SpecClause (本文 + 出自 + embedding)。
  受入: 仕様を節/箇条単位に分割しノード化。
- **T22 明示リンカ** — コードの `@implements SPEC-xxx` / 仕様内シンボル参照 → 確定エッジ。
  受入: 明示参照を高信頼度エッジ化。
- **T23 構造リンカ** — 命名・配置ヒューリスティックでコード↔仕様を中信頼度リンク。受入: 命名一致等で候補エッジ。
- **T24 意味リンカ** — embedding/LLM で段落↔コード照合 (低信頼度・*信号*)。受入: 類似で候補エッジ (信頼度付き)。
- **T25 信頼度/根拠付きエッジ + 硬化ループ** — 各エッジに confidence+evidence。低信頼度→批准→明示昇格の
  批准フロー。受入: 批准でエッジが明示昇格し永続。

## G5. supply / verify (重心)

- **T26 複雑度メトリクス + codebase 相対閾値** — game-aware メトリクス (機構オーバーラップ/共有 state fan-in/
  機構跨ぎ依存深さ + 補助) を DAG/KG 集計。閾値はリポ自身の分布 (上位 %) から (DESIGN §9.2)。
  受入: メトリクス算出 + リポ分布から閾値導出。
- **T27 着地点決定** — 機構 (意味論) × 層ルール × 既存兄弟 → 着地点 (信頼度付き)。novel は提案。
  受入: 既存機構は具体ファイルまで、新機構は層+提案を返す。
- **T28 supply 束組み** — target/task → クリーン文脈束 (着地点/適用ルール/手本/仕様束/影響半径/重複回避) を
  **決定的に** (安定ソート) 組み、`orderSegments` で不変前・可変後ろ。受入: 同一入力→同一束 (content-addressed)。
- **T29 verify (5 ゲート)** — diff → 再パース → 適用ルール (global∪機構) 評価 + 重複/仕様結合/結合デルタ/
  規約 → 構造化 verdict (ゲート別 pass/fail + アンカー + 修正示唆)。受入: 違反を具体アンカー付きで返す。

## G6. アダプタ

- **T30 MCP アダプタ** — `anatomia.context(task)` / `anatomia.verify(diff)` / `anatomia.where(task)` /
  `anatomia.impact(anchor)` を MCP tool で公開。受入: MCP クライアントから 4 tool が叩ける。
- **T31 CLI ゲート** — CI 用に verify をブロッカーとして実行 (block ゲート違反で非 0 終了)。受入: diff を渡すと verdict + exit code。
- **T32 Web viz アダプタ (静的)** — DAG/KG・機構カード・複雑度ヒートマップを Web 表示 (`render_pipeline` 流)。
  受入: グラフ + 複雑度が閲覧できる。

## G7. 動的トレース (DESIGN §5)

- **T33 静的ループ骨格抽出** — `main()`/tick から call graph で System tick 順序を描く。受入: あるべきループ構造を出力。
- **T34 マーカー自動注入 (C++)** — 機構境界 (機構カード入口) に Anchor ID 埋め込みのスコープマーカーを codegen。
  受入: 機構入口にマーカーが入り、ビルド可能。
- **T35 マーカー自動注入 (C#)** — 同上 (ProfilerMarker/EventSource 系)。受入: C# 機構入口にマーカー。
- **T36 フレーム同期スコープ計測ランタイム** — フレームカウンタ + zone スタック (Anchor ID)、プロセス内
  リングバッファ。受入: フレーム毎の active zone 集合を低オーバヘッドで記録。
- **T37 trace 配信 transport** — `ergo_custos` inAppBridge `/stream` 相乗りでトレースを別プロセスへ stream。
  受入: ライブでトレースを受信できる。
- **T38 zone ↔ カード 縫合** — zone(Anchor ID) ↔ 機構カードを join。受入: 「フレーム N の active 機構」を出す。
- **T39 計測ビルド戦略** — Release 計測フラグ (KS は Release 必須) でマーカー有効/無効を切替。受入: 計測 Release ビルドが通る。

## G8. 動的可視化

- **T40 フレーム×機構タイムライン** — 各フレームの System/機構を順序・時間付きで表示。受入: タイムライン描画。
- **T41 光るグラフ** — 静的 DAG/KG を現在 active な Anchor で点灯。受入: ライブで点灯。
- **T42 You are here カーソル** — 現在フレーム + active zone を「局面=…/機構=…/関数=…」で表示
  (局面は §5.5 保留のため当面は機構/関数まで)。受入: 現在地ライブ表示。

## G9. 配線 + 結合テスト

- **T43 e2e 配線** — parse → DAG → グラフ/KG → 機構・ルール → 仕様リンク → supply/verify → MCP/CLI を
  1 本に配線。受入: 1 リポ (AdventureCube) を入力に context/verify が end-to-end で動く。
- **T44 結合テスト + 計測レポート** — e2e のテスト + 計測 (ハッシュ命中率/ルール取りこぼし率/束決定性/
  verify 精度)。受入: 全 feature が結合状態でテスト green + 計測値レポート。

---

## レビュー (Opus)

- 全タスク完了後に **Opus が総レビュー** (`coding-conventions` / `test-review` 観点)。
- 特に **T10 ハッシュ命中率** と **T29 verify 精度** は重点レビュー (設計の前提が懸かる)。
