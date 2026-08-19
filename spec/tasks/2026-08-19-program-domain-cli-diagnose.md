---
task: program-domain-cli-diagnose-20260819
project: Anatomia
kind: 実装
created: 2026-08-19T08:30:00.000Z
memory_links:
  - spec/feature/domain-dual-layer.md
  - spec/interface/cli.md
---
# プログラムドメイン診断 CLI (`anatomia domains program`)

## 目的
二層ドメインのプログラム側 (layer 分類 + `unclassified` diagnostic) を CLI から見る手段が無く、
`.anatomia/layers.json` を書いても unclassified が 0 になったかを web の program-domain-view か
`pr-review` の dualLayer でしか確認できなかった。各リポへの layers.json 投入 (別タスク) と
Revisor 二層 gate の enforced 切替の前提として、操作者が手元で確認できる lens を足す。

## 完了条件
- [x] `anatomia domains program [--project <id> | --repo <path>] [--json] [--unclassified]`:
  layers.json の有無 / layer 別 (domain・module・symbol 数) / unclassified module 一覧
  (moduleId・symbol 数・reason・対象ファイル) を出す。gate ではなく lens (常に exit 0)。
- [x] CLI と Revisor gate (`review/dual-layer-gate.ts`) が同じ module/symbol 構築を共有する
  (`domains/program/diagnose.ts` の `buildProgramDomainInputs`)。CLI で 0 なら gate も pass。
- [x] typecheck green。diagnose 単体テスト + CLI テスト (layers.json 無し → 全 unclassified、
  投入後 → 0、`--json --unclassified` の形状)。vitest はセッション方針により未実行。
- [x] `spec/interface/cli.md` / `spec/feature/domain-dual-layer.md` に追記。

## スコープ (編集可ディレクトリ)
- `src/domains/program/`, `src/review/dual-layer-gate.ts`, `src/adapters/cli.ts`,
  `src/adapters/__tests__/`, `spec/`
