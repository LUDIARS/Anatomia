# feature: グラフエクスポート & 複数プロジェクト管理パネル

## 目的

解析したコードグラフ（KG）を可視化する 2 経路：単発の自己完結 HTML と、常駐の
複数プロジェクト管理 Web パネル。

## グラフ HTML エクスポート

`export-graph -o <file>`（CLI、`exportGraphHtml`）。解析 ctx から vis-network データを組み、
依存無しで開けるインタラクティブ HTML を 1 ファイル出力する。出力例文言：
`exported graph to <file> (<N> files, <M> functions)`。

## 管理パネル（web サーバ）

`web --port <n>`（既定 4200）/ `--home <dir>` で Hono の HTTP サーバを常駐起動
（`src/adapters/web/server.ts`）。ProjectManager を背後に持ち、複数プロジェクトの
登録・解析・閲覧を提供する。常駐ゆえ解析済みプロジェクトを warm に保持し、harness の
per-edit / per-prompt フック（`/api/verify` / `/api/context`）に sub-second で応答する。

提供 API は [interface/web.md](../interface/web.md) を参照（解析系 read API、
プロジェクト管理、per-project データ、warm harness、cost-feed、cache-stats、trace）。

### パネルのタブ

ダッシュボードは `Graph` / `Domain View` / `Hotspots` / `Domains` / `Spec Links` のタブを持つ。

- **Graph**: 全グラフ。グループ絞り込みに加え、**ブランチ差分オーバーレイ**（[feature/branch-diff.md](./branch-diff.md)）
  を持つ。「Branch diff only」で `/api/projects/:id/branch-diff` の追加/変更 anchor だけに絞り、
  追加=緑/変更=橙の枠で色付けする。「+1-hop」で 1 ホップ隣接も表示。
- **Domain View**: ドメイン別フォーカスの専用ビュー（[feature/domain-view.md](./domain-view.md)）。
  ドメインを選ぶとそのドメインの実装関数だけにグラフを絞り、紐づく spec 節（日本語）を表示する。

## 制約

- web は `bin/anatomia.mjs` のうち `process.exit` を呼ばず event loop で常駐する唯一の経路。
- 単一プロジェクトモード（bare AnalysisContext）で起動した場合、mutation 系ルートは 501 を返す。

## 関連

- データ: [data/project-cache.md](../data/project-cache.md)（レジストリ + 増分キャッシュ）
- 起動/環境変数: [setup/environment.md](../setup/environment.md)
