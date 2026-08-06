---
title: Anatomia knowledge integration quality report
type: test
service: anatomia
domain: knowledge-model
status: planned
x-anatomia:
  kind: knowledge-quality-report
---

# Knowledge integration quality {#SPEC-knowledge-quality-report}

T69 の scenario catalog は `src/knowledge/quality/fixtures.ts`、計測式は
`src/knowledge/quality/metrics.ts` に置く。現状の登録テストは計測式だけを検証しており、spec-only、code-only、mixed、rename、
hierarchy conflict、scene rename、trace enrichment の application/migration pipeline を実行する fixture は未実装である。

品質値は parser precision/recall、identity expectation accuracy、assignment evidence coverage、
replay hash 一致、regeneration byte 一致で報告する。比率は 0 件を failure と誤認しないよう 1 とし、
sample count を必ず併記する。

`quality.test.ts` の数値は formula unit test 用の合成入力であり、parser や migration の実測 baseline ではない。
T69 完了には各 scenario を実際の parser/application/migration pipeline へ通し、生成された ID、conflict、
replay hash、再生成 bytes から report を構築する登録テストが必要である。

既知限界:

- executable legacy DomainDef は実行せず conflict として報告する。
- canonical scene に一致しない manual scene は自動作成せず conflict にする。
- 実機 trace の妥当性は instrumented target による別検証（#174）を要する。
