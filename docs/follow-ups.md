# Anatomia — 残作業 (follow-ups)

**状態 (2026-06-15)**: G0–G9 全パイプライン + 衝突修正 + TypeScript フロントエンド + 自己解析(dogfood)
+ verify 言語対応 + measure AST-aware + 複数プロジェクト対応 + 静的グラフエクスポート +
Web 管理パネル まで実装済 (**396 tests green**, `LUDIARS/Anatomia` private)。実装=Sonnet / レビュー=Opus。

以下は **設計済みだが未実装/保留**、または **実運用に向けた配線**。優先度順。

---

## A. 重心の実現 — "AI が実際にクリーンに書く" を回す【最優先】✅ 実装済 (2026-06-15)

1. ~~**MCP を実 AI に接続**~~ ✅ stdio MCP サーバ起動口 `bin/anatomia-mcp.mjs` +
   Claude Code 登録 `.mcp.json` + 手順 `docs/mcp-setup.md`。`main()` が `resolveProviders()`
   で本番プロバイダを配線し、起動時に stderr へ wiring 診断を出力。Famulus/Concordia も同 stdio で接続可。
2. ~~**実 LLM / embedder 配線**~~ ✅ `src/providers/`:
   - `anthropic-llm.ts` — Anthropic SDK 蒸留 (default `claude-opus-4-8`、env で haiku 等に変更可)
   - `openai-embedder.ts` — OpenAI 互換 `/v1/embeddings` (OpenAI / ローカル Ollama / Voyage)
   - `hash-embedder.ts` — 決定的オフライン fallback (zero-vector より良い実類似シグナル、テスト/閉域用)
   - `index.ts` `resolveProviders()` — env から解決、未設定なら stub LLM + hash embedder に graceful fallback
   - `buildVerdict(ctx, diff, targetPath?, {providers, cardCache})` で **duplication ゲートが実 embedder +
     LLM 蒸留カードで動く** (mock の「常に pass=ザル」を解消)。env 仕様は `docs/mcp-setup.md`。

## B. 検出精度 — generic → 実用 【次の一手】

3. **ゲーム別ドメインオントロジー plugin** — builtin は汎用で過剰マッチ
   (state-machine が全ノードに当たる)。AdventureCube/KS 用 (Skill/Action/Shield/Melee/beat 等) を
   `ANATOMIA_PLUGIN_DIR` に。loader は配線済・中身が空。**これが detection を意味あるものにする鍵**。
   - ⚠️ **設計上の前提条件 (今回の調査で判明)**: 検出は `CodeNode.name` の namePattern で照合するが、
     C++ のインラインメソッドはノード名がベア (`apply`/`fire`/`tick`)、クラス名が取れない。
     かつ `NodeFilter` に **ディレクトリ/ファイルスコープが無い** ため、ドメインを `src/skill/activation/`
     等に絞れず汎用パターンが過剰マッチする。→ B-3 を「意味ある」ものにするには **`NodeFilter` に
     `pathPattern` を追加** (types.ts + predicate matcher + engine + detect) するのが先決。
     AC の実不変条件 (例: `IAction` 派生は Enemy/Player を呼ばない passive data carrier、
     `ISkillEffect` は戦闘を直接実行しない) を `forbiddenCall` + pathPattern で表現できる。

## C. 設計上の保留

4. **局面学習 (§5.5)** — 手法未選定 (クラスタ vs FSM induction、トレース圧縮)。
   You-are-here の phase は当面 null。
5. **動的トレースの実機検証** — G7/G8 は TS 側ロジック + 生成 C++/C# マーカーテンプレまで。
   実ゲームビルドへ注入 → コンパイル → 実行 → ライブトレースは未検証。実 KS/AC ビルドで。

## D. 機能の隙間

6. **spec linking の external dir 対応** — `analyze()` は root 配下の `spec/*.md` のみ拾う。
   code=`src/` / spec=`spec/` の一般形に、外部 spec ディレクトリ指定オプションを。
7. **Web パネル運用** — loopback 前提なら現状可。公開するなら認証 (他 LUDIARS 同様 loopback 限定が素直)。

## E. リポ整備

8. **CLAUDE.md + README** — LUDIARS 慣習。AI/人間向けの使い方・アーキ・規約。
9. **branch+PR 運用へ移行** — 本セッションの build は fresh repo の一気構築で直 main。
   今後は LUDIARS 規約 (feat ブランチ + PR + 自動マージ) に。
10. **publish 要否** — lib/CLI/MCP を他サービスが consume するなら GitHub Packages、
    ローカル運用なら不要。略称 `An` の `project-codes` 正式登録。
11. **機構→ドメイン 一貫性最終確認** — PR #2 (f2642ed) で rename 済。残留 "mechanic" 表記の最終チェック
    (self-analysis で `src/domains/` 確認済、概ね完了)。

---

## 完成済み (参考)

静的層 (Merkle-AST + α正規化 + signature ハッシュ / 衝突0・false-invalidation 0%) / グラフ+Kuzu /
ドメイン+ルール (述語engine/preset/template/逆生成/plugin loader/検出/カード) / コード↔仕様3段リンカ+硬化 /
supply+5ゲートverify (決定論束) / アダプタ (MCP/CLI/Web) / 動的トレース+可視化 / TypeScript対応 /
複数プロジェクト (registry/cache/manager) / 静的グラフエクスポート / Web 管理パネル。
計測正本: `docs/measurement-report.md` (AdventureCube) / `docs/self-analysis.md` (Anatomia 自身)。
