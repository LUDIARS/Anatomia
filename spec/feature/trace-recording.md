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

## ローカル実機検証 runbook

実ゲーム/GPU を使わずに録画経路を点検する手順と、実ゲームでライブトレースを取る手順を分ける。

### A. GPU 無しのローカル検証 (経路の点灯を先に確かめる)

実ゲームのビルド前に、録画 JSONL を手書きして **parse → decode → stitch → scene → 局面発見 → FSM** が
最後まで流れることを確認できる。`src/dynamic/record/__tests__/phase-flow.test.ts` が複数フェーズの
trace を生成し、この全段を 1 テストで検証する(GPU 不要・決定的)。

```sh
npx vitest run src/dynamic/record/__tests__/phase-flow   # 経路が通ることの即時確認
```

JSONL 1 行の形式 (各 zone の anchorId は注入時に焼き込み済み):

```json
{"type":"frame_begin","frameId":1,"timestampUs":0}
{"type":"zone_enter","anchorId":"combat_hit","timestampUs":5}
{"type":"zone_exit","anchorId":"combat_hit","timestampUs":95}
{"type":"frame_end","frameId":1,"timestampUs":100}
```

手書き trace を CLI に通すこともできる(anchorId は対象プロジェクトの domain implementor に一致させる):

```sh
anatomia trace ingest --project <id> --file ./hand-trace.jsonl            # scene 一覧
anatomia trace ingest --project <id> --file ./hand-trace.jsonl --entry <domain> --scope domain
```

### B. 実ゲームでライブトレースを取る (GPU/ビルドが要る = ユーザ側)

| 手順 | コマンド / 操作 |
|------|----------------|
| 1. 注入計画を生成 | `anatomia trace plan --project <id> --out ./trace-plan` → `anatomia_zones.h` + `anatomia_zones.patches.json` |
| 2. ヘッダを取り込む | 計装する .cpp で `#define ANATOMIA_MEASUREMENT_BUILD` → `#include "trace-plan/anatomia_zones.h"` |
| 3. zone マーカー適用 | `patches.json` の各 `{filePath,line,code}` をドメイン実装関数へ挿入(`ANATOMIA_ZONE("name","anchorId")`) |
| 4. frame マーカー手置き | メインループ先頭/末尾に `ANATOMIA_FRAME_BEGIN(idx)` / `ANATOMIA_FRAME_END(idx)`(loop 自動特定は未対応) |
| 5. 計測ビルド | `ANATOMIA_MEASUREMENT_BUILD` 定義で Release ビルド(Pictor/KS の実行はユーザ側 = [[feedback_pictor_no_run]]) |
| 6. 実走して録画 | `ANATOMIA_TRACE_FILE=/tmp/game.jsonl ./game ...` で JSONL が貯まる |
| 7. ingest で scene 化 | `anatomia trace ingest --project <id> --file /tmp/game.jsonl` |
| 8. warm で確認 | `ANATOMIA_TRACE_FILE=/tmp/game.jsonl anatomia web --project <id>` → `POST /api/integral` が実 scene を返す |

ステップ 1〜4・7・8 は Anatomia 側で完結 (私が支援可)。GPU を要する 5・6 のみゲーム側 (ユーザ実行)。

## 限界

- **ライブ録画(ゲームを実走させて記録)は本 PR の範囲外**: C++ 計装ヘッダ + 注入計画 + ingest は
  揃ったが、KS のメインループへのマーカー適用とビルド/実走はゲーム側作業(Pictor 実行はユーザ側)。
- scene の粒度はドメインの粒度に従う。単一ドメイン支配のリポは scene も粗い → 多 scene 化は
  ドメイン authoring([[domain-authoring]]) の精緻化に依存。
- frame マーカーは手置き(loop 自動特定は未対応)。
