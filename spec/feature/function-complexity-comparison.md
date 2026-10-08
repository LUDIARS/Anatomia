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
- 宣言の字句文脈（囲み関数・型・namespace・変数宣言・object property名、callback の callee宣言構造・引数位置・同 call の文字列登録名）

body と行番号は含めない。したがって body 編集・行ずれ・別 worktree をまたいでも key は一致する。
`structuralHash` も併記するので、消費側は「移動しただけで中身が変わっていない関数」を
一意に特定できる。

同一 identity（真のオーバーロード）は重複排除せずそのまま残す。消費側は曖昧な行を
勝手にペアリングしてはならない。出力は key 昇順、同 key 内は value 昇順、同値なら
structuralHash昇順で決定的に並ぶ。最終tie-breakは出力順だけで、bodyをidentityや対応付けには使わない。

### 母集団

`quality.complexity` と `quality.functionComplexity.functions` は同じハッシュ済み関数出現の母集団である。
同じ Anchor ID の複数出現もそれぞれ1行・1件として重み付けする。summary は snapshot の
value をそのまま集計するので件数・平均・最大・scoreが同じ証拠に由来する。
`computeMetrics` の anchor 単位母集団と `changedFunctions` の既存契約は維持する。
欠測は既存どおり例外、曖昧keyは削除・ordinal付与で隠さない。新しいlexicalContextが
抽出されない手組みのFunctionNodeには従来のkeyを使用する。実解析のbase/headは同じ
analyzer versionを使用し、消費側の件数確認・曖昧identity fallbackは引き続き必須。

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
