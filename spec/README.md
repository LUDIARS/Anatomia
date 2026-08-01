# Anatomia 仕様書

Anatomia の永続仕様は AIFormat の分類に従って `spec/` に置く。原則として現在のコードから
確認できるデータ、機能、外部境界、セットアップ、テスト契約を扱う。まだ実装されていない
独立した目標契約は OKF frontmatter の `status: planned` と実装タスクへのリンクを必須とする。
既存の current spec に移行差分を追記するときは `planned` 見出しと目標契約/タスクへのリンクを
必須とし、現行 API が既にその契約を満たすようには記述しない。

## 構成

| 分類 | 内容 |
|---|---|
| [`data/`](./data/) | Merkle DAG、プロジェクトキャッシュ、domain knowledge log、LLM キャッシュ、cost feed |
| [`feature/`](./feature/) | 静的・動的解析、OKF、domain organization、context supply、レビュー、Web view |
| [`interface/`](./interface/) | CLI、MCP、Web HTTP API |
| [`setup/`](./setup/) | 必要環境、依存、環境変数、起動経路 |
| [`test/`](./test/) | テスト種別、hermetic 原則、実行方法 |

## 現行の中核フロー

1. [静的解析](./feature/static-analysis.md)で正規化 AST、Merkle DAG、コードグラフを作る。
2. [仕様リンク](./feature/spec-linkage.md)と[ドメイン検出](./feature/domain-detection.md)を重ねる。
3. [context supply](./feature/context-supply.md)で作業に必要な範囲を供給する。
4. [verify](./feature/verify-gates.md)または[コードレビュー](./feature/code-review.md)で変更や構造を検査する。
5. [集中的テスト](./feature/focused-testing.md)でユーザー優先度を解析対象へ重ね、Augurへ決定的な重点テスト事実を渡す。
6. [画面構成](./feature/screen-composition.md)と[シーン導出](./feature/scene-derivation.md)で
   画面・実行局面・workflow をシーン層に射影し、fingerprint キー付きシーンキャッシュとして永続化する。
7. spec 正本が LUDIARS レイアウトに沿わないリポは[spec 正本パス設定](./feature/spec-source-config.md)で
   在処を設定する（未設定は自動検出 → 見つからなければ報告）。

操作順の正本は[解析手順](./feature/analysis-procedure.md)、外部境界は
[CLI](./interface/cli.md)、[MCP](./interface/mcp.md)、[Web API](./interface/web.md)を参照する。

## 計画中の domain / scene 統合フロー

planned contract では、次の権威順と操作順へ統一する。

1. authored [OKF](./feature/okf-generation.md)を clause 単位に解析し、code を混ぜず domain /
   subdomain 候補を作る。
2. [domain organization](./feature/domain-organization.md)の Gate A で domain の意味・境界・階層を
   人が承認する。
3. 承認済み domain に対する assign / move / unassign / spec-gap は Gate B、新 domain は authored
   OKF を補って Gate A、split / merge / hierarchy / boundary は Gate C で補正する。
4. 承認結果を [domain / scene knowledge log](./data/domain-knowledge-log.md)へ transaction として保存し、
   Kuzu、taxonomy、DomainDef、Web cache を projection として再構築する。
5. scene は code / asset を正本として全自動導出し、同じ log から generated scene OKF と UI を作る。

仕様書は domain ごとの物理配置へ強制移動しない。AIFormat の分類を保ったまま、stable
SpecClause ID と typed edge で複数 domain に結ぶ。詳細な移行順と残作業は
[`../docs/plan-okf-domain-scene-flow.md`](../docs/plan-okf-domain-scene-flow.md)、
タスクの管理正本は [`../TASKS.md`](../TASKS.md)。

## 仕様監査

- [spec 構造レビュー](./feature/spec-review.md): AIFormat の分類・索引・`.gitignore` 罠を決定的に検査する。
- [コード構造レビュー](./feature/code-review.md): 違反、hotspot、cycle、重複、孤立、spec gap を列挙する。
- [ドメインレビュー](./feature/domain-review.md): coverage、cohesion、overlap、boundary drift を検査する。
- [シンボル探索](./feature/symbol-navigation.md): 関数検索と直接 caller/callee の確認に使う。
