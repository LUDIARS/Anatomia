# Anatomia 利用者向け説明 — 編集者向け README

共通契約: AIFormat `FORMAT_HANDBOOK.md`（handbook_version "1"）。Actio 01057364 / 6abd6f2e（neco 2026-09-08 指示、2026-10-13 に作成を確認）。

## 目次

| order | id | 章 | status |
|---|---|---|---|
| 0 | overview | Anatomia とは | draft |
| 10 | register-project | プロジェクトを登録して解析する | draft |
| 20 | before-coding | 書く前に着地点と手本を確かめる | draft |
| 30 | verify-changes | 書いた後に変更を検査する | draft |
| 40 | review-pr | PR 全体を構造レビューする | draft |
| 50 | browse-panel | 管理パネルでドメインを眺める | draft |

## 確認記録

- 静的照合: `b8ecdb9`（main）。README のクイックスタート、`spec/ux/product.md`、`src/adapters/cli.ts` の
  サブコマンド (`project add/analyze/list/remove`、`where`、`context`、`plan`、`map`、`verify`、`pr-review`、
  `review`、`web`)、各 `spec/feature/*.md` と照合した。
- 実操作確認: **未実施**。各章のコマンド出力・画面表示は実行して確かめていない。
- 公開承認: なし（全章 `draft`）。

## 未確認・未配線

- `contexts.json` の key（`project.register` など）は原稿側で定義しただけで、管理パネル・CLI への配線は未実装。
- 管理パネルの「コードを見る (Tela / Web)」（審査中の PR #2813）は、マージと実操作確認の後に `browse-panel` へ追記する。
- `pr-review` の「配送されうる関数」「宣言済みの入口」の欄は PR #2790 で入った表示名に基づく。実際の表示名は実操作で確認していない。
- MCP 経由の利用（`docs/mcp-setup.md`）は今回の章に含めていない。
