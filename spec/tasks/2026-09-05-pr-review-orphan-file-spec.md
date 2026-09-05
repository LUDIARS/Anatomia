---
task: pr-review-orphan-file-spec
project: Anatomia
kind: 実装
created: 2026-09-05
memory_links: []
---
# pr-review の changedOrphans がファイル冒頭の `@spec` を見ていない

## 目的

PR #1395 (DDD 第 2 PR、main `0b5a4a31f59a` にマージ済み) の Revisor 所見に、非ブロックで
「3 changed function(s) are orphaned」が残った。対象は次の 3 関数である。

- `draftDomainRelations` — `src/knowledge/domain/relation-llm.ts:84`
- `isLayerWarning` — `src/supply/plan/store.ts:121`
- `isPlanItem` — `src/supply/plan/store.ts:130`

いずれのファイルも冒頭の doc コメントに `@spec` を持っており、同じ差分を
`verify` に流すと `spec_linkage` は **PASS** する。

```sh
# 同じ差分・同じ base で結果が食い違う
git diff dd11f80..HEAD | node bin/anatomia.mjs verify --repo .   # spec_linkage PASS
node bin/anatomia.mjs pr-review --repo . --base dd11f80          # changedOrphans に 3 件
```

つまり `verify` の `spec_linkage` ゲートと `pr-review` の `changedOrphans` が、
**同じ「仕様に紐づいているか」を別の基準で判定している**。`pr-review` 側だけが
ファイル冒頭の `@spec` を関数へ継承していない疑いが濃い。

これを放置すると、`spec/tasks/2026-09-05-plan-spec-linkage-orphans.md` が解こうとした
「仕様が無い」と「仕様はあるがリンクが無い」の区別が、Revisor 所見の側で崩れたままになる。
実装者は verify が緑でも所見に orphan が出続けるため、所見を信用しなくなる。

## 完了条件

- `pr-review` の `changedOrphans` 判定が、`verify` の `spec_linkage` と同じ根拠を使うことを
  確認する。食い違いの原因 (ファイル冒頭 `@spec` の継承有無、anchor の解決範囲、
  spec clause の読み込み元のいずれか) を特定し、PR 説明に 1 行で書く。
- どちらが正しいかを決める。ファイル冒頭 1 行の `@spec` を関数へ継承する運用を正とするなら
  `pr-review` 側をそれに合わせ、関数ごとの注釈を要求する運用を正とするなら
  `verify` 側と `spec/feature/spec-linkage.md` をそれに合わせる。**両者が食い違ったままにしない。**
- 上記 3 関数 (`draftDomainRelations` / `isLayerWarning` / `isPlanItem`) が、
  同じ base に対する `pr-review` で orphan として報告されなくなる。
  報告され続けるべきだと判断した場合は、なぜ仕様節に対応しないのかを PR 説明に書く。
- 判定根拠を 1 か所に寄せたことをユニットテストで固定する
  (同じ入力に対して `spec_linkage` と `changedOrphans` が同じ関数集合を返すこと)。
- `spec/feature/spec-linkage.md` と `spec/feature/pr-diff-review.md` の記述を、
  採用した基準に揃える。
- `npm run typecheck` / `npm run build` green、`npm test` は既知の未初期化 submodule
  (`lib/aiformat`) 由来の 1 件を除いて green。Revisor local PR 提出。

## スコープ (編集可ディレクトリ)

- `src/review/` (`pr-diff.ts` / `build.ts`)
- `src/supply/gates/` / `src/spec/`
- `spec/feature/spec-linkage.md` / `spec/feature/pr-diff-review.md`
