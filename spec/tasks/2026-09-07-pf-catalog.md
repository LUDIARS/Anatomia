---
task: pf-catalog
project: Anatomia
kind: 実装
created: 2026-09-07
memory_links: []
---
# Pf が参照できるサービス所有 catalog を復元する

## 目的
稼働中の Anatomia を Ex の正本に登録し、Pf が接続先を推測せず参照できるようにする。

## 完了条件
- 本体フォルダの multi-project web CLI をサービス定義にする。
- 接続先を `ANATOMIA_URL` として Ex topology に公開する。
- 既存の稼働プロセスとプロジェクト registry を保持する。

## スコープ (編集可ディレクトリ)
- excubitor.catalog.yaml
