---
task: reconciliation-review-followup-20260719
project: Anatomia
kind: 実装
status: done
created: 2026-07-19T00:00:00.000Z
source_session: lictor-c23315c1-37f4-42f5-82e3-b14802c17871
memoria_task_id: 571
actio_task_id: null
memory_links:
  - review/Anatomia/2026-07-19/
  - review/Anatomia/reconciliation-latest.json
---
# 2026-07-19 突合レビュー対応 (Anatomia)

## 目的
daily-review-reconciliation (2026-07-19, HEAD 12e3ee1→d0cc4d6, PR #102 Unity lifecycle認識 + class-view graph投影) で Codex が検出した所見に対応する。Opus は同PRを所見0件で確認 (基本ケースは健全)。両者一致所見は無く、いずれも Codex 単独 (medium) — 次回差分での再出現有無を確認してから優先度を最終判断すること。

## 完了条件
- [x] `src/frameworks/unity/lifecycle.ts:90` — メソッドシグネチャ/修飾子を無視するため、同名の非ライフサイクルメソッド (引数付き/static 等) を誤って orphan 除外する。
- [x] `src/frameworks/unity/lifecycle.ts:64` — MonoBehaviour 継承判定が型の単純名 (namespace 無視) でグローバルにマージされ、無関係な同名クラスが誤って Unity lifecycle 扱いになる。
- [x] `src/graph/view-projection.ts:74` — class 投影が free function を全て落とすため、class-centric 判定された C++ リポでグラフが空/大幅欠落になる。
- [x] `src/graph/view-projection.ts:38` — C# partial class がファイル単位で別ノード化され、同一クラス内呼び出しが偽の跨クラス edge として表示される。partial class は name 単位でマージして解消 (トレードオフ: 異なる namespace の同名クラスも統合されるが、表示用投影として許容)。
- [x] `src/project/profile.ts:38` — Unity マーカー探索の FS エラー (EACCES/EIO 等) を無言で「マーカー無し」扱いし、誤った framework profile のまま解析が成功してしまう。
- [x] `src/adapters/web/vis-data.ts:365` — 互換ペイロードが function graph 全体を top-level と `views.function` に二重シリアライズし、大規模リポで API/静的HTMLサイズが肥大化する。キャッシュキーを vis-data-v2 へ更新し旧ペイロードの再利用も防止。
- [x] `src/project/fingerprint.ts:28` — fingerprint 対象拡張子に無制限 `.txt` を追加したため、解析に無関係な巨大テキスト資産まで全読み込みされる。ProjectSettings/ProjectVersion.txt のみ明示的に許可。

## スコープ (編集可ディレクトリ)
- `src/frameworks/unity/`, `src/graph/`, `src/project/`, `src/adapters/web/`

## 実施結果 (2026-07-21)
PR [#104](https://github.com/LUDIARS/Anatomia/pull/104) で全7項目対応済み・test/build/typecheck green (並行セッションによる実装。重複PR #103・#105 はクローズ済み)。残作業なし。
