# Augur ブリッジ

`POST /api/projects/:id/test-suggestions` が Augur へ計画を依頼する経路の正本。
transport の正本実装は `src/adapters/augur.ts`、ルート側 (request 組み立てと
HTTP ステータスの割り当て) は `src/adapters/web/routes/test-suggestions.ts`。

## トランスポートは子プロセス

Augur は常駐プロセスを持たない CLI として提供される (Augur
`spec/plan/daemonless-cli.md`)。サービスもポートも存在しないため、Anatomia は
HTTP ではなく子プロセスで呼ぶ。

```
node <augurDir>/bin/augur.mjs plan --request - --json
```

- 組み立て済みの `CreatePlanRequest` を **stdin** に渡す。Anatomia は解析結果と
  ユーザの objective から request を既に組み立てており、Augur が知らない作業
  ディレクトリから再導出させると 2 つの答えが混ざる。
- `PlanResponse` を **stdout** から読む。
- **request と response の形は変わっていない。** 変わったのは transport だけで、
  ルート自身の契約 (受け取る body / 返す JSON) も従来どおり。

`process.execPath` で shell を介さず起動する。argv は Anatomia が所有しており
shell に再解釈させない。呼び出し側の PATH に `augur` がある保証も無い。

stdin への書き込み失敗 (CLI が request を読み切る前に終了した場合の EPIPE 等) は
それ自体を失敗とせず stderr に記録するだけで、結果は終了コードで判定する。
未処理の error イベントでサーバ全体を落とさないための扱い。

## 設定

| 変数 | 既定 | 意味 |
|---|---|---|
| `ANATOMIA_AUGUR_DIR` | `../Augur` | Augur チェックアウトの場所 |

到達先ではなく**パス**である点が旧構成との違い。`ANATOMIA_AUGUR_URL` /
`AUGUR_URL` は廃止した。

## エラーの区別

| 状況 | HTTP | 応答 |
|---|---|---|
| `<augurDir>/bin/augur.mjs` が無い | 503 | `error: "Augur is not available"`、`augurDir`、設定方法を含む detail |
| CLI が非ゼロ終了 | 502 | `error: "Augur plan request failed"`、`exitCode`、CLI が stderr に書いた文言 |
| 10 分で応答しない | 502 | CLI を SIGKILL し、`exitCode: null` + stderr に timeout の旨 |
| stdout が JSON でない | 502 | `error: "Augur returned a response that is not JSON"` |

JSON でない、には `null` / 配列 / 数値のような **オブジェクトでない JSON** も含む。
これらは parse は通るが `testPlan` を引けないので、ルートが 500 で落ちる代わりに
他の使えない応答と同じ 502 に落とす。

チェックアウトが無いのはセットアップの問題 (旧構成でサービスが起動していない
のと同じ意味) なので 503、走った上で拒否したのは計画の失敗なので 502。
CLI の終了コードは 1 が usage/validation、2 が内部エラーで、いずれも stderr の
文言をそのまま detail に載せる。これは旧 HTTP 400 envelope が運んでいたのと
同じテキスト。

## テスト

`mountTestSuggestionRoutes(app, source, runner?)` の `runner` にスタブを渡して
検証する。グローバル `fetch` を差し替える手は使えない — transport がプロセスに
なった以上、差し替える対象のグローバルが存在しない。

`runner` を渡した場合はチェックアウトの解決を行わない。注入された transport は
自前の経路を持っており、実行しないバイナリの存在を要求すると、Augur を配置
しない環境でブリッジがテスト不能になる。

## 関連

- Augur `spec/interface/cli.md` — `plan --request` を含むフラグ面
- Augur `spec/plan/daemonless-cli.md` — 移行 A2b (この変更)
- [feature/focused-testing.md](../feature/focused-testing.md)
- [interface/web.md](./web.md)
