---
title: Anatomia — その codebase の grain に逆らわないコード生成を支える
type: feature
ux_definition: 1
id: UX-AN-PRODUCT
service: anatomia
ux_scope: product
status: draft
owner: engineering-owner
---

# Anatomia のプロダクト UX

本文書は [DESIGN.md](../../DESIGN.md) §1 と [README](../../README.md) の確定事項から起こした draft。
価値 ID と判断方法は設計案であり、人間の承認や測定が済んだことを意味しない。
DDD ゲート (spec/ux の存在と `spec/domains/` の specRefs) を満たすための入口として置き、
内容の確定は責任者の判断に従う。

## 誰の、どの状況の問題か

LUDIARS のリポジトリでコードを書く AI セッション (Claude / Codex) と、その成果を審査する
人間・Revisor。既存ドメインを再発明する、結合を無闇に上げる、仕様の意図に結びつかない、
周りと一貫しない、という「その codebase の grain に逆らう」生成が起きても、書いた後の
レビューでしか気づけない。代替手段の全文 grep や人手のレビューは、規模が増えると
見落としと再作業を生む。

## このプロダクトが何を解決するか

利用前: 生成のたびに文脈を集め直し、逸脱は事後レビューで拾う。
利用後: 生成前に着地点・適用ルール・手本・影響半径・重複候補を決定的に供給し (supply)、
生成後に 5 ゲートで機械的に検証する (verify)。同じ意味のコードは同じ Anchor ID で
キャッシュされ、呼び出し・セッション・リポを跨いで再利用される。

## どの価値を実現するか

| 価値 ID | 利用者に起きる望ましい変化 | 判断方法・条件 | 証拠 | 現状 |
|---|---|---|---|---|
| UX-AN-W1 | 書く前に「どのドメインに属し、どのルールが効き、何を再利用できるか」が分かる | `where` / `context` / `find` が着地点・ルール・候補を返し、hook (supply) が着手前に注入する | CLI / MCP 出力と hook ログ | 運用中 (精度は未測定) |
| UX-AN-W2 | 書いた後の逸脱 (規約・重複・仕様未結合・結合上昇・慣習ずれ) が機械的に止まる | `verify` 5 ゲートが diff に対して pass / fail と anchor を返し、Revisor ゲートが落とす | verify 出力、Revisor 審査記録 | 運用中 (誤検知の既知例あり) |
| UX-AN-W3 | 同じ意味のコードには同じ ID が付き、解析とカードが再利用される | 正規化 Merkle-AST の hash 命中率と束決定性 (`npm run measure`) | 計測レポート | 計測手段あり、目標値未設定 |
| UX-AN-W4 | コードと仕様節が双方向に引け、ドメインの境界を人が承認して育てられる | SpecClause リンクと domain organization (Gate A / B / C) の承認記録 | knowledge log | Gate 系は planned |

数値目標 (命中率・誤検知率) は未決定。評価者は各リポの実装セッションと Revisor 審査結果。

## 主要シナリオと失敗からの回復

- 着手前: hook が `where` / `context` を呼び、着地点・ルール・候補を注入する。Anatomia 未到達や
  未解析プロジェクトでは「供給できない」と明示し、黙って空を渡さない。
- 生成後: `git diff | anatomia verify --repo <path> --json` を hook と Revisor が呼ぶ。
  解析不能は fail として扱い、pass に読み替えない。
- ドメイン未宣言: `target domain is still missing` で止める。宣言は `spec/domains/` に JSON で書き、
  パース失敗は警告なく捨てられるため、書いたら JSON parse と正規表現を通す。
- LLM / embedder 設定不備は stub へ黙って落とさず即エラーにする (`ANATOMIA_LLM_BACKEND=stub` は明示時のみ)。

## 守る制約と優先順位

1. 決定性: 同じ入力から同じ Anchor ID・同じ束。キャッシュは content-addressed。
2. hermetic: テストは外部 API / ファイルシステムの実依存を持ち込まない。
3. supply→verify が重心。可視化や検索は supply→verify を支える範囲で優先する。
4. DAG は acyclic 必須、KG はその派生ビュー。用語を混同しない。

## コア / 支援 / 汎用の分類理由

| 分類 | ドメイン | 理由 |
|---|---|---|
| コア | supply-verify, static-anatomy, domain-modeling, spec-linkage | 価値 W1 / W2 / W4 を直接決める。着地点の供給、ID の決定性、所属と仕様結合の意味を所有する |
| 支援 | dynamic-analysis, integral-search, deterministic-cache | 供給と検証の精度・再利用性を高めるが、意味は変えない |
| 汎用 | delivery-surface, platform-foundation | CLI / MCP / Web の入口とファイル走査。交換しても価値は変わらない |
