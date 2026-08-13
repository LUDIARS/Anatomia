# feature: PR 差分の一時レビュー（ephemeral PR diff review）

## 目的

CI から「この PR ブランチが merge-base に対して何を変えたか」を 1 リクエスト分の
一時的な証拠として出す。登録プロジェクトのスナップショットを汚さずに、差分・ドメイン
所属・品質・アーキテクチャ・spec ギャップを 1 つの JSON にまとめる。

## 振る舞い

```sh
anatomia pr-review --repo <worktree> [--base <ref>] --json
```

`buildPrDiffReview(ctx, { base? })`（`src/review/pr-diff.ts`）：

```
computeBranchDiff (branch/diff.ts) … 関数粒度のブランチ差分 + 変更 AnchorId 集合
branchDiffText   (branch/git.ts)   … merge-base ↔ 作業ツリー の unified diff
buildVerdict     (core.ts)         … その unified diff に 5 ゲート検証
buildReview / buildDomainReview    … 違反 / 循環 / 構造重複 / overlap / drift / isolation
computeMetrics   (supply/metrics.ts) … 関数ごとの cyclomatic / fanIn / fanOut / coupling
summarizeComplexity                … 0..100 の複雑度スコア
→ 変更 AnchorId 集合で全部を絞り込んで PrDiffReview を返す
```

### 一時性（永続化しない）

`analyze()` を直接呼ぶだけで、**ProjectManager / プロジェクトレジストリ / 永続 CacheStore を
一切使わない**。呼び出し側が 1 リクエスト分シリアライズするのは自由だが、Anatomia 側は
保存しない（`temporary: true` がその印）。この不変条件を守るため CLI は `pr-review` に
`--project` を渡された場合エラーにする（`resolveContext`, `src/adapters/cli.ts`）。

ドメイン検出は repo 内の編集可能なドメイン定義（`domainsDir(repoPath)`）を plugin として
読むので、ターゲットドメインの所属判定はそのブランチの定義で決まる。

### 返り値（`PrDiffReview`）

| フィールド | 内容 |
|---|---|
| `diff` | 関数粒度のブランチ差分（→ [branch-diff.md](./branch-diff.md)） |
| `domain` | 変更 Anchor のターゲットドメイン所属 / 未所属 Anchor |
| `quality` | 複雑度サマリ + 変更関数のメトリクス + 変更 orphan 関数 |
| `architecture` | 5 ゲート検証結果、違反 / 循環 / 構造重複 / ドメイン間結合 / overlap / drift / isolation |
| `spec` | 変更ファイルのうち spec リンクが無いもの |

### 複雑度スコア

`summarizeComplexity(metrics)` は平均 cyclomatic から
`100 / (1 + (averageCyclomatic - 1) / 4)` を計算し、四捨五入して 0..100 に clamp する
（avg=1 → 100、avg=5 → 50、関数 0 件 → 100）。単調減少・決定的。

しきい値は Anatomia の関心事ではない：呼び出し側が「PR worktree のスコア」と
「別途解析した merge-base worktree のスコア」を比較して判断する（= ワークフロー方針）。

## 制約

- 差分・検証の対象は解析対象拡張子のソースのみ（→ [static-analysis.md](./static-analysis.md)）。
- `branchDiffText` は tracked ファイルの差分しか出さない（未追跡の新規ファイルは
  `computeBranchDiff` の関数差分には出るが unified diff には現れない）。
- package manifest / lockfile / `.gitmodules` / vendored lib などの依存系ファイルは、
  ソース Anchor の対象外でも tracked diff のパスから別途検出する。layer 分類器には
  builtin の infrastructure 入力として渡し、依存系ファイルだけの PR は spec /
  ビジネスドメイン未所属を gate 違反にしない（→ [domain-dual-layer.md](./domain-dual-layer.md)）。
- 5 ゲートは diff から再構成したソースを解析する経路なので、`verify` の Anchor は
  全体解析の AnchorId とは一致しない（→ [verify-gates.md](./verify-gates.md)）。
- git CLI に依存。git リポでない / base が無い場合、`diff.available` が false になり
  検証はスキップされる（例外にしない）。

## 関連

- インターフェース: [interface/cli.md](../interface/cli.md)
- 差分の土台: [feature/branch-diff.md](./branch-diff.md)
- ゲート: [feature/verify-gates.md](./verify-gates.md)
