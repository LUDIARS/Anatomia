---
task: explicit-linker-spec-annotation
project: Anatomia
kind: 実装
created: 2026-08-09
memory_links: []
---

# explicit.ts のアンカーを spec clause へ結びつける

## 目的

Revisor local PR #390 が非ブロック所見として `2 changed function(s) are orphaned` を
報告した。対象は `src/spec/explicit.ts` に追加した関数で、同ファイルが `@spec`
アノテーションを持たないため spec_linkage がファイルリンクを解決できない。

同じ層の `src/spec/structural.ts` は `@spec Structural リンク` を持っており、そちらの
変更は orphan にならなかった。つまりコード品質の問題ではなく、片方だけ注釈が
欠けているだけである。

リンク先の見出しは既に存在する:
`spec/feature/spec-linkage.md` の `### Explicit リンク（\`src/spec/explicit.ts\`）`。

## 完了条件

- `src/spec/explicit.ts` のファイル冒頭コメントに、上記見出しへ解決する `@spec`
  アノテーションを追加する。
- 追加後に `git diff | anatomia verify --repo <repo> --json` を回し、`spec_linkage`
  が pass することを確認する (アノテーションが実際にリンクを生むことの確認であって、
  警告を消すことが目的ではない)。
- `anatomia links list` で `explicit.ts` を from とする explicit リンク
  (confidence 1.0) が現れることを確認する。

## スコープ (編集可ディレクトリ)

- `src/spec/`
