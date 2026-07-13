# Anatomia 仕様書

Anatomia の永続仕様は AIFormat の分類に従って `spec/` に置く。実装計画ではなく、
現在のコードから確認できるデータ、機能、外部境界、セットアップ、テスト契約を扱う。

## 構成

| 分類 | 内容 |
|---|---|
| [`data/`](./data/) | Merkle DAG、プロジェクトキャッシュ、LLM キャッシュ、cost feed |
| [`feature/`](./feature/) | 静的・動的解析、context supply、domain modeling、レビュー、Web view |
| [`interface/`](./interface/) | CLI、MCP、Web HTTP API |
| [`setup/`](./setup/) | 必要環境、依存、環境変数、起動経路 |
| [`test/`](./test/) | テスト種別、hermetic 原則、実行方法 |

## 中核フロー

1. [静的解析](./feature/static-analysis.md)で正規化 AST、Merkle DAG、コードグラフを作る。
2. [仕様リンク](./feature/spec-linkage.md)と[ドメイン検出](./feature/domain-detection.md)を重ねる。
3. [context supply](./feature/context-supply.md)で作業に必要な範囲を供給する。
4. [verify](./feature/verify-gates.md)または[コードレビュー](./feature/code-review.md)で変更や構造を検査する。
5. [集中的テスト](./feature/focused-testing.md)でユーザー優先度を解析対象へ重ね、Augurへ決定的な重点テスト事実を渡す。

操作順の正本は[解析手順](./feature/analysis-procedure.md)、外部境界は
[CLI](./interface/cli.md)、[MCP](./interface/mcp.md)、[Web API](./interface/web.md)を参照する。

## 仕様監査

- [spec 構造レビュー](./feature/spec-review.md): AIFormat の分類・索引・`.gitignore` 罠を決定的に検査する。
- [コード構造レビュー](./feature/code-review.md): 違反、hotspot、cycle、重複、孤立、spec gap を列挙する。
- [ドメインレビュー](./feature/domain-review.md): coverage、cohesion、overlap、boundary drift を検査する。
- [シンボル探索](./feature/symbol-navigation.md): 関数検索と直接 caller/callee の確認に使う。
