# feature: ブランチ差分解析（branch diff）

## 目的

「このブランチが base から何を変えたか」だけを関数粒度で解析し、**全体解析（メインテーブル）に
紐づいたまま**、ビューをブランチ差分のみに絞れるようにする。差分は全体解析の上の *ビュー* で
あって、リポ全体の別解析ではない（DESIGN: キャッシュ/グラフがデータ構造そのもの）。

## 振る舞い

`computeBranchDiff(ctx, { base? })`（`src/branch/diff.ts`）：

```
git (branch/git.ts):
  resolveBase  … base ref を解決（既定: origin/main → main → origin/master → master）し
                 merge-base(base, HEAD) を fork 点として得る
  changedFiles … merge-base ↔ 作業ツリー の変更 + 未追跡新規ファイル（=コミット済 + 未コミット）
  fileAtRef    … merge-base 時点の各ファイル内容
分類 (dag/diff.ts diffFiles):
  after  = ctx.files（warm な全体解析の作業ツリー版。未変更ファイルは再パースしない）
  before = merge-base の内容をパースして得た FileNode
  → added / changed / removed を AnchorId 比較で確定
```

### 重要: AnchorId はファイルパスを含む

`assignAnchorId`（`src/dag/hash.ts`）はハッシュ入力に **slash 正規化したファイルパス**を畳み込む。
よって before 側は analyze() が使ったのと**同じ絶対パス**でハッシュしないと全関数が「changed」に
化ける。`fileNodeFromSource(absPath, …)` は `join(repoPath, relPath)` を渡す。

### 返り値（`BranchDiff`）

- `available` / `reason`: git リポでない / base が見つからない時は `available:false`（例外でなく no-op）。
- `base` / `mergeBase` / `branch` / `head`。
- `files[]`: `{ path, status(added|deleted|modified), added[], changed[], removed[] }`。
- `anchors`: `{ added, changed, all }` — **現在のグラフに存在する** AnchorId。パネルはこれで
  メイングラフを差分のみに絞る。
- `summary`: filesChanged / functionsAdded / functionsChanged / functionsRemoved。

## パネルでの使われ方

Graph タブのオーバーレイ（[feature/graph-export-and-panel.md](./graph-export-and-panel.md)）。
「Branch diff only」で `anchors.all` のノードだけ表示し、added=緑 / changed=橙 の枠に色付け。
「+1-hop」で隣接ノードも含める。route は `GET /api/projects/:id/branch-diff[?base=<ref>]`。

## 制約

- 解析対象拡張子は `.cpp/.h/.cs/.ts/.tsx`（`.d.ts` 除外）。spec(.md) 等は差分対象外。
- バイト差分はあるが関数粒度の delta が無い（コメントだけ等）ファイルは結果に含めない。
- git CLI に依存（`execFile`）。git 不在/失敗は全て null/false に握りつぶす。

## 関連

- インターフェース: [interface/web.md](../interface/web.md)
- データ: [data/merkle-dag.md](../data/merkle-dag.md)（AnchorId / FileNode）
