# トレース運用ガイド — 実行トレースを日常運用で回す

実行トレース (動的解析) を**いま実際にどう運用するか**の手引き。仕様の正本は
[`spec/feature/trace-recording.md`](../spec/feature/trace-recording.md)（録画経路 + 実機 runbook）と
[`spec/feature/dynamic-trace-and-phase.md`](../spec/feature/dynamic-trace-and-phase.md)（局面学習）。
本書は「どの経路が今動くのか / どこが未配線か / 日常オペの手順」に絞る。

## 結論サマリ

| 経路 | 状態 | 運用 |
|---|---|---|
| **録画ファイル (JSONL) → CLI ingest** | ✅ 動く（正規運用） | ゲームが追記する JSONL を `trace ingest` で何度でも読み直す（near-live） |
| **録画ファイル → warm サーバ (`ANATOMIA_TRACE_FILE`)** | ✅ 動く（起動時 1 回読み） | 更新を反映するには warm サーバ再起動が必要 |
| **ライブストリーム (socket/UDP)** | ❌ 未配線 | `LiveTraceSource` / `createTraceReceiver` は部品のみ。運用不可（下記「未配線」） |

つまり **「ライブトレース」の現実解 = ゲームは JSONL に追記し続け、Anatomia 側は
ファイルを読み直す**。ストリーム接続は存在しない。

## 0. 前提

- ゲーム側の計装 (マーカー注入 → 計測ビルド → 実走) の手順は
  [`spec/feature/trace-recording.md`](../spec/feature/trace-recording.md) §「実ゲームでライブトレースを取る」が正本。
  GPU を要するビルド/実走はユーザ側作業（Pictor/KS 実行はユーザ側ルール）。
- JSONL の 1 行形式（`frame_begin` / `zone_enter` / `zone_exit` / `frame_end`）と
  GPU 無しの手書き検証も同仕様書 §A にある。
- anchorId は**注入時に焼き込み済み**なので、ingest 側での名前解決は不要。

## 1. 日常オペ A: CLI ingest ループ（推奨・near-live）

ゲームが `ANATOMIA_TRACE_FILE=<path>` で JSONL を書いている（または書き終えた）状態で:

```sh
# 最新のトレースを scene 化して見る（何度でも。毎回ファイルを読み直す）
node bin/anatomia.mjs trace ingest --project <id> --file <path-to.jsonl>

# scene 付き integral search（局面を指定して探索範囲を絞る）
node bin/anatomia.mjs trace ingest --project <id> --file <path-to.jsonl> \
  --entry <domain> --scope domain
```

- `trace ingest` は実行のたびにファイル全体を parse → decode → stitch → scene 化する。
  ゲームを走らせながら**定期的に叩けば near-live** に局面が見える（決定的・LLM 不要）。
- 出力の scene id は `phase:<hotDomain>` 形式（局面署名ベース）。

## 2. 日常オペ B: warm サーバに scene を点灯させる

warm サーバ (port 4200) の scene 層（`POST /api/integral`、scene-modules ビュー）に
実トレースを流すには、**起動時に** `ANATOMIA_TRACE_FILE` を渡す:

```sh
ANATOMIA_TRACE_FILE=<path-to.jsonl> node bin/anatomia.mjs web --port 4200
```

重要な制約: **ファイルは server 起動時に 1 回だけ読まれる**（`server.ts` の
`readTraceFile()`、readFileSync once）。追記された内容を反映するには再起動する。

- Ars ワークスペースの正規経路は hook spawn（`.claude/hooks/anatomia-hooks-lib.mjs` の
  `ensureServer()`）。トレースを点灯させたい間は spawn 環境に `ANATOMIA_TRACE_FILE` を
  設定してから旧プロセスを停止 → hook で再 spawn する（再起動は Excubitor 経由 +
  Concordia claim のワークスペースルールに従う）。
- ファイルが無い/読めない場合は無言で scene 空に縮退する（graceful）。設定したのに
  scene が空なら、まずパスと読み取り権限、次に JSONL 形式を疑う。

## 3. 静的シーン導出との住み分け

- トレースが無いプロジェクトは、静的シーン導出
  （[`spec/feature/scene-derivation.md`](../spec/feature/scene-derivation.md)、
  `anatomia scenes` / `GET /api/projects/:id/scenes`）が scene 層を埋める。
- トレース由来 scene は**実挙動の正**。マージ規則は manual > discovered（trace / 静的導出）で、
  id 衝突時は手動定義（`spec/data/<project>.scenes.json`）が勝つ。
- 運用指針: まず静的導出で scene 地図を持ち、重要プロジェクトだけ計測ビルドで
  トレースを取り局面 (phase) を重ねる。

## 4. 未配線（ライブストリーム）と将来の配線ポイント

以下は**部品はあるが production で誰も使っていない**。「ライブ」をストリームで
実現する場合の配線ポイントとして残す:

- `dynamic/viz/trace-source.ts` の `LiveTraceSource` — ring buffer を保持する live 用
  TraceSource。**インスタンス化箇所ゼロ**。
- `dynamic/transport.ts` の `createTraceReceiver(AsyncIterable<TraceEvent>)` — イベント列の
  消費側。**socket/UDP からイベント列を作る source factory が存在しない**のが欠落点。
- 配線する場合: (a) UDP/名前付きパイプの listener → `AsyncIterable<TraceEvent>` を実装、
  (b) `web` 起動時に `LiveTraceSource` を組んで `traceSource` として注入
  （`createServer` は既に `traceSource?: TraceSource` を受ける）、(c) ゲーム側レコーダに
  ファイルではなく socket への emit を追加。現状の運用ニーズは A/B（ファイル読み直し）で
  足りているため、明確な需要が出るまで未実装のままとする。

## 5. トラブルシュート

| 症状 | 見る場所 |
|---|---|
| ingest しても scene が 0 | JSONL の anchorId が対象プロジェクトの domain implementor と一致しているか（`trace plan` の焼き込みを使ったか） |
| warm の integral に scene が出ない | `ANATOMIA_TRACE_FILE` を**起動時に**渡したか（後から export しても無効）・再起動したか |
| frame が組み立たない | `frame_begin`/`frame_end` がペアで入っているか（メインループへの手置き漏れ） |
| 計測ビルドで no-op | `ANATOMIA_MEASUREMENT_BUILD` define と `ANATOMIA_TRACE_FILE` env の両方が要る |
