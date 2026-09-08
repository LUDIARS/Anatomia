# Function complexity comparison

## 目的

集約スコア（`summarizeComplexity`）は平均なので、無関係な関数の増減でも動く。
「この関数が悪化したか」には答えられない。`quality.functionComplexity` version 1 は
全関数のスナップショットを 1 行ずつ出し、base と head を関数単位で突き合わせられるようにする。
既存の集約スコアは記述的な指標として後方互換のまま残す。

## 振る舞い

`buildComplexitySnapshot(repoPath, functions, metrics)`（`src/review/complexity-snapshot.ts`）。

指標は call-out-degree-plus-one（グラフ近似）であり、AST 由来の cyclomatic complexity ではない。
`metric` フィールドにその名前を載せ、消費側が別物と取り違えないようにする。

### 識別子

key は次を連結して SHA-256 で畳む：

- repo 相対パス
- 囲みの型（`enclosingType`、自由関数は空文字列）
- 関数名
- 正規化した signature shape

body と行番号は含めない。したがって body 編集・行ずれ・別 worktree をまたいでも key は一致する。
`structuralHash` も併記するので、消費側は「移動しただけで中身が変わっていない関数」を
一意に特定できる。

同一 identity（真のオーバーロード）は重複排除せずそのまま残す。消費側は曖昧な行を
勝手にペアリングしてはならない。出力は key 昇順、同 key 内は value 昇順で決定的に並ぶ。

## 制約

- スナップショットにソーステキストと絶対パスを含めない。
- ハッシュ未割り当ての関数（`id` が無いもの）はグラフノードでないので、行を出さずに読み飛ばす。
- ハッシュ済みなのにメトリクスが無い場合は例外にする。欠けた行は消費側から「関数が消えた」と
  読めてしまうため、不完全な証拠を出すより解析を失敗させる。例外メッセージには関数名と
  repo 相対の位置を含める。
- 下流の回帰チェックは同一 key の関数どうしを比較し、追加・削除は別枠で報告する。

## 関連

- 呼び出し元: [feature/pr-diff-review.md](./pr-diff-review.md)
- メトリクスの定義: [feature/verify-gates.md](./verify-gates.md)
