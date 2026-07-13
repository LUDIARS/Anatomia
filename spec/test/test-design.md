# test: テスト設計

## ランナー / 実行

- **vitest**（`npm test` = `vitest run`）。テストは `src/` 内に同居
  （`*.test.ts` および `__tests__/` 配下）。現状約 74 のテストファイル。
- 型チェックは `npm run typecheck`（`tsc --noEmit`）、ビルドは `npm run build`。

## hermetic 原則（このプロジェクト特有の「充実」軸）

Anatomia は決定的キャッシュ + 解析オラクルなので、**API 鍵が無くても全テストが通る**ことが
担保の核。LLM / embedder は注入式で、未設定時は hash-embedder + zero-vector mock + mock カードに
graceful fallback する。よって duplication ゲートはプロバイダ無しで always-pass、解析は
パース失敗ファイルを skip して crash しない。テストはこの「未設定経路」を hermetic に検証する。

## 種別と担保内容

| 種別 | 対象 | 何を担保 |
|---|---|---|
| ビルド/型 | 全 `src/` | `tsc` が通る（`npm run build` / `typecheck`） |
| ユニット: DAG | `src/dag/__tests__`（10） | parse / extract / normalize / hash の決定性、Merkle のソート順序非依存、増分 diff、TypeScript 経路 |
| ユニット: domains | `src/domains`（7） | ドメイン検出（detect / engine / presets / template / mining / card 蒸留 / ontology） |
| ユニット: focused testing | `src/domains/focused-testing.test.ts` + Web route tests | domain priority、変数照合、リスク自動推定、Augur転送、入力拒否の決定性 |
| ユニット: spec | `src/spec`（5） | parse / explicit / structural / semantic / harden の各リンカ |
| ユニット: supply（ゲート） | `src/supply/__tests__`（4） | 5 ゲート（rule_conformance / duplication / spec_linkage / coupling_delta / convention_drift）と verdict 集約 |
| ユニット: cache | `src/cache/__tests__`（7） | store / file-store / redis-store / resolve（backend 優先度）/ instrumented / transcript / stats |
| ユニット: graph | `src/graph/__tests__`（3） | in-memory / kuzu 射影 / query |
| ユニット: dynamic | `src/dynamic` + `phase` + `viz`（計 15） | スケルトン / マーカー codegen / protocol / ringbuffer / transport / stitch / build-strategy / 局面学習（signature/discover/fsm/label/classify）/ viz |
| ユニット: cost | `src/cost/__tests__`（2） | cost-feed の取り込み + 集計 |
| ユニット: providers | `src/providers/__tests__`（2） | embedder / LLM プロバイダ解決 |
| ユニット: project | `src/project/__tests__`（1） | レジストリ + 増分キャッシュ |
| アダプタ統合 | `src/adapters/__tests__`（12）+ web（1） | CLI（verify/project/cache-stats）、MCP（project/providers/cache-obs）、web（project/cache/harness/cost route）、export。MCP transport 無しで handler を直接叩く形で検証 |

## 計測（テストとは別レーン）

`npm run measure`（`scripts/measure.mjs`）でハッシュ命中率 / 束決定性 / verify 精度を計測、
`node scripts/self-analyze.mjs` で自分の `src/` を dogfood 解析する（docs/self-analysis.md）。

## 関連

- 検証対象機能: [feature/verify-gates.md](../feature/verify-gates.md)、[feature/static-analysis.md](../feature/static-analysis.md)
- キャッシュ: [data/llm-cache.md](../data/llm-cache.md)、[data/project-cache.md](../data/project-cache.md)
