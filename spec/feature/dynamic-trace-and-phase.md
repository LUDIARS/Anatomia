# feature: 動的解析（実行トレース → 局面学習, G7/G10）

## 目的

静的 DAG に、実行時の挙動（どのゾーンがいつ active か = 局面）を重ねる層。
「You-are-here」を静的着地点に加えて動的な現在地（phase）で示すための機構。

T63-T66 の canonical scene contract では、trace が作る phase/scene は **runtime observation** であり、
code / engine asset が定義する canonical
scene identity、composition、transition を上書きしない。同じ stable scene ID へ対応できる場合は
origin=`trace-observation`、trace/source revision、observed anchors を provenance として加える。
対応できない phase は provisional diagnostic のまま保持する。

## 状態

**録画経路は CLI まで配線済み**: `anatomia trace plan`（マーカー注入計画）/
`anatomia trace ingest`（録画 JSONL → scene 化）が使える
（→ [trace-recording.md](./trace-recording.md)、運用手順は `docs/trace-operations.md`）。
`anatomia trace ingest` は trace から直接 `SceneModel` を作る legacy compatibility 経路である。
canonical sync/query は `SceneDefinitionSeed` と `SceneObservation` を分離し、trace から scene identity を作らない。
**ライブストリーム（socket/UDP）は未配線**: `LiveTraceSource` / `createTraceReceiver` は
部品のみで、production に source factory が存在しない。

## 流れ（`src/dynamic/`）

```
ゲートに録画フレーム → stitchFrame(zone ↔ card)
  → discoverPhases()  局面語彙を発見
  → induceFsm()       局面遷移を誘導
  → labelPhases()(LLM) 局面にラベル
  → buildClassifier().classifyWindow(現フレーム)  現フレームの局面分類
  → buildWhere(..., phaseId) で You-are-here に phase 表示
```

構成（`src/dynamic/index.ts`）：

- スケルトン抽出（`skeleton.ts`）/ C++・C# スコープマーカー codegen（`inject-cpp.ts` / `inject-csharp.ts`）
- wire protocol + ring buffer デコーダ（`protocol.ts` / `ringbuffer.ts`）/ トレース transport（`transport.ts`）
- zone↔card join（`stitch.ts`）/ build strategy（`build-strategy.ts`）
- 動的 viz（`viz/`、timeline / active overlay / where）
- 局面学習（`phase/`: signature / discover / fsm / label / classify）

## 局面ラベルキャッシュ

`labelPhases()` の LLM 蒸留結果は namespace `phase` で content-addressed キャッシュに載る
（→ [data/llm-cache.md](../data/llm-cache.md)）。

## 関連

- web の trace 系 API（`GET /api/trace/timeline|active|where`、→ interface/web.md）は
  動的 viz データを返す経路として server に定義されている。`trace/where` は `?project` で指定した
  project（未指定時は選択中 project）の検出済み domain membership で active anchor を解決し、
  active anchor が無い場合だけ `domain=null`、
  membership が無い active anchor は `domain=unassigned` を返す。
- canonical scene: [scene-derivation.md](./scene-derivation.md)
