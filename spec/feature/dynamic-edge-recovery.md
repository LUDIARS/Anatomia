# feature: 動的裏取りによる辺の復活（dynamic edge recovery）— 設計

**状態: 設計のみ（未実装）。** 本書は B-6 の後半（動的裏取り）の設計を確定する。
前半（落とした辺の記録 = `CodeGraph.unresolved`）は実装済み（→ [static-analysis.md](./static-analysis.md)）。

## 目的

静的解析は偽陽性回避（phantom edge を作らない）のために呼び出し辺を意図的に落とす
（純粋仮想 interface 越し / 外部型 / 型不明レシーバ / 候補なし。→ static-analysis.md
「呼び出し辺の解決」）。その代償として、真の virtual dispatch 辺がコールグラフから欠ける。

本機能は、この欠けた辺を**動的トレースの観測事実**で復活させる：
実行時に「caller → callee が実際に呼ばれた」ことが観測されたら、その辺を
`evidence: "dynamic"` タグ付きでグラフに合流させる。推測ではなく観測なので、
「偽陽性を減らす（信頼）」の設計思想を壊さずにコールグラフの網羅を回復できる。

## 設計

### 1. 観測ペアの取得（トレース → caller/callee ペア）

動的層の zone は **Anchor ID を注入時に焼き込む**（→ [trace-recording.md](./trace-recording.md)）。
デコード済みフレーム内の zone enter/exit のネストから、観測ペアを導く：

```
zone_enter(A) の active 中に zone_enter(B) が起きた（同一フレーム・同一スタック）
  → 観測ペア (caller=A, callee=B)
```

zone はドメイン実装関数の入口に置かれる（マーカー自動注入、DESIGN §5.2）ため、
ペアは関数粒度の Anchor ID 同士で得られる。直接呼び出しだけでなく多段（A→x→B の
中間 x が非計装）も「A active 中の B」として観測されるので、突合（次節）で
unresolved 記録と一致するものだけを辺に採用する。

### 2. unresolved 記録との突合（join）

観測ペア (caller, callee) を `CodeGraph.unresolved` と突合する：

```
u.from == caller
∧ graph.nodes.get(callee).name の終端名 == u.calleeName
∧ (u.receiverType があれば callee の enclosingType が u.receiverType の階層に属する)
```

一致した観測ペアのみを「復活辺」とする。unresolved に無い観測ペアは採用しない
（非計装の中間関数を飛び越えた偽の直接辺を作らないため。突合が「静的に落とした
まさにその辺」だけを復活させるフィルタになる）。

### 3. 永続化: `spec/data/dynamic-edges.json`（committed）

復活辺はリポジトリに**コミットされるデータ**として永続化する（トレース自体は
コミットしない。観測の要約だけを残す）：

```json
{
  "version": 1,
  "edges": [
    {
      "from": "<AnchorId>",
      "to": "<AnchorId>",
      "kind": "calls",
      "evidence": "dynamic",
      "reason": "abstract-no-impl",
      "traceDigest": "<sha256 of source trace file>"
    }
  ]
}
```

- `from`/`to` は content-addressed な Anchor ID。**コードが変わると anchor が消え、
  該当エントリは自然に無効化される**（stale エントリはビルド時に endpoints 不在で
  スキップ。掃除は再生成で行う）。
- `reason` は元のドロップ理由（監査用）。`traceDigest` は由来トレースの同定用。
- エントリはソート済み・重複排除で書き出す（決定性）。乱数・時刻は使わない。

### 4. graph build 時のオーバーレイ合流

`buildGraph` の後段で `dynamic-edges.json` を読み、**両端の anchor がグラフに存在する**
エントリだけを `Edge` として追加する。`Edge` 型に `evidence?: "static" | "dynamic"`
を追加し（既定 = static、省略可でキャッシュ形状の互換を保つ）、追加辺には
`evidence: "dynamic"` を付ける。dynamic-edges.json の内容は graph のキャッシュキーに
畳み込む（ファイル digest を `GRAPH_CACHE_VERSION` 系のキーに追加。導入時に
バージョンバンプ）。

### 5. verify / impact での利用

- **verify（rule_conformance）**: 動的証拠辺も通常の calls 辺として評価する。
  静的には見えなかった「abstract 越しに禁止層を呼ぶ」違反が、観測事実に基づいて
  検出できるようになる。violation の evidence 文字列に `evidence=dynamic` を明記する。
- **impact（影響半径）**: BFS が動的証拠辺も辿る。virtual dispatch 越しの実利用先が
  影響半径に入る（現状は欠けている）。
- gate 側で「dynamic 辺のみ除外」したい場合に備え、`EdgeFilter` に evidence 絞り込みを
  足せる余地を残す（初期実装では区別せず全辺評価）。

## 前提（実装順序）

実装は **実トレース録画経路（DESIGN §5.2 マーカー注入 → ringbuffer →
`RecordedTraceSource`）の配線完了後**に行う。`trace plan` / `trace ingest` の経路は
既にある（→ trace-recording.md）が、実ゲームのライブ録画（計測ビルド + 実走）は
ゲーム側作業で未完。実トレースが無い段階で本機能を実装しても突合対象が存在しない。

実装時の入口は `anatomia trace ingest` の後段（decode 済みフレームが揃う場所）に
recover ステップを足し、`spec/data/dynamic-edges.json` を再生成する形を想定する。

## 決定性

- 同一トレース + 同一コード → 同一の dynamic-edges.json（ソート・dedup・digest 固定）。
- graph build への合流は committed ファイル依存のみ（実行時の観測には依存しない）。
- Anchor ID の content-addressing がコード変更時の自動失効を保証する。

## 関連

- 静的側の記録: [static-analysis.md](./static-analysis.md)（`CodeGraph.unresolved`、
  reason = `abstract-no-impl` / `external-type` / `unresolved-receiver` / `no-local-candidate`）
- 動的層: [dynamic-trace-and-phase.md](./dynamic-trace-and-phase.md)（トレース、Anchor ID 縫合）
- 録画経路: [trace-recording.md](./trace-recording.md)（plan / ingest、ライブ録画の残作業）
- 検証ゲート: [verify-gates.md](./verify-gates.md)
