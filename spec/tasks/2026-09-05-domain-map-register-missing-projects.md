---
task: domain-map-register-missing-projects
project: Anatomia
kind: 実装
created: 2026-09-05
memory_links:
  - anatomia-warm-server-panel
---
# 横断検索に出ないプロジェクトを共有レジストリへ登録する

## 目的

横断ドメインマップは共有レジストリ (`E:/Document/Ars/.anatomia/projects.json`) に
登録されたプロジェクトだけを索引する。PR #1393 の実データ確認で、
**Figmentum が未登録のため `map search "切り絵のデモを実装する"` に
`figmentum/kirie-transform` が出ない**ことが分かった (fixture テストでは固定済み)。

設計 §12 が挙げる代表例そのもの (Pictor + Figmentum の多リポ選択) が実環境で再現
できないので、索引の価値がそのまま欠ける。同種の未登録リポが他にもある可能性がある。

これは Anatomia の実装欠陥ではなくレジストリの整備不足だが、放置すると
「map に出ない = そのプロダクトは無い」と誤読される。

## 完了条件

- `E:/Document/Ars` 配下の実リポジトリと `projects.json` の登録内容を突き合わせ、
  未登録のリポを列挙する (最低でも Figmentum)。
- 未登録リポを `anatomia project add` で登録し、`ontologyDir` / `specDirs` が
  実在パスを指していることを確認する。
- 既存エントリのうち rootPath が消えた worktree を指しているもの
  (設計文書 §1 が指摘する stale エントリ) を洗い出し、更新または削除する。
- 登録後に `anatomia map search "切り絵のデモを実装する"` を実行し、
  `figmentum/kirie-transform` が上位に出ることを確認する。
- レジストリは全セッション共有なので、変更内容と理由を記録に残す。

## 委託元による追記 (2026-09-05)

- `augur` の登録が Revisor の一時クローン (`%TEMP%/repos/Augur`) を指していた件は、
  委託元が API 経由で `E:/Document/Ars/Augur` へ再登録済み (133 ファイル / 795 関数を解析)。
- 残るのは他の未登録プロジェクトの洗い出しと stale エントリの掃除。
