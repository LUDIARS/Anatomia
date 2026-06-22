# Trace Recording — シーン層を実トレースで点灯させる

## 目的

scene 層([[integral-search]] の第3層)は「トレースがあれば流れる」配線まで済んでいた。
本機能はその**録画経路**を閉じる: ゲームを計装 → TraceEvent を記録 → Anatomia が
読み戻して scene にする。これで実プロジェクトの scene が空でなくなる。

## 経路

```
計装(マーカー注入) → 実行 → JSONL 録画 → ingest → decode → stitch → scene → integral
```

1. **マーカー注入** (`dynamic/inject-cpp.ts`, 既存 + runtime emit 実装):
   - `generateCppHeader(true)` = ヘッダオンリーの JSONL レコーダ。`ANATOMIA_MEASUREMENT_BUILD`
     でのみ有効、出力先は env `ANATOMIA_TRACE_FILE`(未設定なら記録 no-op)。
   - `ANATOMIA_ZONE(name, anchorId)` = RAII で zone_enter/exit を emit。**anchorId は注入時に
     焼き込む**ので ingest 側で name→anchor 解決が要らない。
   - `ANATOMIA_FRAME_BEGIN/END(id)` = メインループに手で置く(Anatomia は loop を自動特定できない)。
   - `generateCppPatches(entryPoints)` = ドメイン実装関数の source 位置に ZONE 呼び出しを差し込む patch。
2. **ingest** (`dynamic/record/ingest.ts`):
   - `parseTraceJsonl` → `processEvents`(既存 ringbuffer) → `DecodedFrame[]`
   - `cardsFromDomains(DetectionResult[])` = **検出結果から LLM 非依存の最小カード**(anchor→domain)
   - `stitchFrame` → `StitchedFrame` → `frameSignature` → scene(`sceneModelFromTraceFile`)
3. **scene → integral**: warm サーバは env `ANATOMIA_TRACE_FILE` を読み、その**プロジェクトの
   domains で per-request に scene を復号**して integral search に流す。

## 取得面

- CLI: `anatomia trace plan --project <id> [--out <dir>]` = ヘッダ + patch 一覧を生成。
  `anatomia trace ingest --project <id> --file <trace.jsonl> [--entry <ref> --scope ...]`
  = 録画 → scene 一覧(+ `--entry` で scene 付き integral)。
- HTTP(warm): `POST /api/integral` が `ANATOMIA_TRACE_FILE` 設定時に実 scene を返す。

## 実証 (KuzuSurvivors)

- `trace plan` = 3 domains / 2108 zone markers。注入計画に実 anchorId が焼き込まれる。
- 実 anchor(glfw_to_ergo_key 等)で録画 JSONL を作り `trace ingest` → scene `phase:state-machine`。
  `--entry state-machine` で integral に `scenes: 1` が surface(KS domains=ks-layer-spine/
  ks-presentation-barrier/state-machine)。

## 限界

- **ライブ録画(ゲームを実走させて記録)は本 PR の範囲外**: C++ 計装ヘッダ + 注入計画 + ingest は
  揃ったが、KS のメインループへのマーカー適用とビルド/実走はゲーム側作業(Pictor 実行はユーザ側)。
- scene の粒度はドメインの粒度に従う。単一ドメイン支配のリポは scene も粗い → 多 scene 化は
  ドメイン authoring([[domain-authoring]]) の精緻化に依存。
- frame マーカーは手置き(loop 自動特定は未対応)。
